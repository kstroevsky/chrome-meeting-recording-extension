import { normalizeWebhookEndpoint } from '../integrations/webhook/WebhookEndpoint';
import type { IntegrationDataPolicy, TranscriptSpeakerPolicy } from '../integrations/contracts';
import type { IntegrationDestination } from '../integrations/persistence';
import type { IntegrationRequestAuthDraft } from '../integrations/management';
import { canonicalizeIntegrationDataPolicy } from '../integrations/policy';
import { normalizeWebhookApiKeyHeader } from '../integrations/webhook/WebhookAuth';
import {
  containsHostPermission,
  removeHostPermission,
  requestHostPermission,
  requestHostPermissions,
} from '../platform/chrome/permissions';
import { sendToBackground } from '../shared/messages';
import { formatBytes } from '../shared/format';

type Elements = {
  document: Document;
  name: HTMLInputElement | null;
  endpoint: HTMLInputElement | null;
  authType: HTMLSelectElement | null;
  authHeader: HTMLInputElement | null;
  authValue: HTMLInputElement | null;
  speakerPolicy: HTMLSelectElement | null;
  policyInputs: NodeListOf<HTMLInputElement>;
  add: HTMLButtonElement | null;
  list: HTMLElement | null;
  recording: HTMLSelectElement | null;
  status: HTMLElement | null;
  secretPanel: HTMLElement | null;
  secretValue: HTMLInputElement | null;
  secretCopy?: HTMLButtonElement | null;
  secretTest?: HTMLButtonElement | null;
};

export class IntegrationSettingsController {
  /** The integration just connected, which the wizard's last step tests (E4). */
  private connected: IntegrationDestination | null = null;

  constructor(
    private readonly el: Elements,
    /** Integrations decide what *Save to* can offer; that section re-reads after a change. */
    private readonly onDestinationsChanged: () => void = () => {},
  ) {}

  static fromDocument(doc: Document, onDestinationsChanged?: () => void): IntegrationSettingsController {
    return new IntegrationSettingsController({
      document: doc,
      name: doc.getElementById('integration-name') as HTMLInputElement | null,
      endpoint: doc.getElementById('integration-endpoint') as HTMLInputElement | null,
      authType: doc.getElementById('integration-auth-type') as HTMLSelectElement | null,
      authHeader: doc.getElementById('integration-auth-header') as HTMLInputElement | null,
      authValue: doc.getElementById('integration-auth-value') as HTMLInputElement | null,
      speakerPolicy: doc.getElementById('integration-speakers') as HTMLSelectElement | null,
      policyInputs: doc.querySelectorAll<HTMLInputElement>('[data-integration-create-policy]'),
      add: doc.getElementById('integration-add') as HTMLButtonElement | null,
      list: doc.getElementById('integration-list'),
      recording: doc.getElementById('integration-send-recording') as HTMLSelectElement | null,
      status: doc.getElementById('integration-status'),
      secretPanel: doc.getElementById('integration-secret-panel'),
      secretValue: doc.getElementById('integration-signing-secret') as HTMLInputElement | null,
      secretCopy: doc.getElementById('integration-secret-copy') as HTMLButtonElement | null,
      secretTest: doc.getElementById('integration-secret-test') as HTMLButtonElement | null,
    }, onDestinationsChanged);
  }

  async init(): Promise<void> {
    this.el.add?.addEventListener('click', () => void this.create());
    this.el.authType?.addEventListener('change', () => this.syncAuthFields());
    this.el.secretCopy?.addEventListener('click', () => void this.copySecret());
    this.el.secretTest?.addEventListener('click', () => {
      if (this.connected && this.el.secretTest) void this.test(this.connected, this.el.secretTest, true);
    });
    this.syncAuthFields();
    await this.loadRecordings();
    await this.refresh();
  }

  private async create(): Promise<void> {
    const name = this.el.name?.value.trim() ?? '';
    const endpointValue = this.el.endpoint?.value.trim() ?? '';
    if (!name || !endpointValue) {
      this.setStatus('Name and HTTPS endpoint are required.', true);
      return;
    }
    let endpoint: ReturnType<typeof normalizeWebhookEndpoint>;
    let requestAuth: IntegrationRequestAuthDraft;
    try {
      endpoint = normalizeWebhookEndpoint(endpointValue);
      requestAuth = this.readRequestAuth();
    } catch (error) {
      this.setStatus(String(error), true);
      return;
    }
    this.setBusy(true);
    let grantedByThisCreate = false;
    try {
      const alreadyGranted = await containsHostPermission(endpoint.hostPermission);
      if (!alreadyGranted) {
        const granted = await requestHostPermission(endpoint.hostPermission);
        if (!granted) throw new Error(`Host permission was not granted for ${endpoint.hostPermission}`);
        grantedByThisCreate = true;
      }
      const response = await sendToBackground({
        type: 'CREATE_INTEGRATION',
        input: {
          name,
          endpoint: endpoint.endpoint,
          // Automatic sending is chosen per recording, under Save to (plan E8); an
          // integration never sends every recording on its own.
          routingDefault: 'manual',
          dataPolicy: this.readPolicy(),
          requestAuth,
        },
      });
      if (!response.ok) throw new Error(response.error);
      this.connected = response.created.destination;
      if (this.el.secretValue) this.el.secretValue.value = response.created.signingSecret;
      if (this.el.secretPanel) this.el.secretPanel.hidden = false;
      if (this.el.authValue) this.el.authValue.value = '';
      const offered = response.profile
        ? ` It is now under Save to as ${response.profile.name}.`
        : ' Add it under Save to above to record with it.';
      this.setStatus(`Added ${response.created.destination.name}. Save the signing secret now; later it can only be rotated.${offered}`);
      this.onDestinationsChanged();
      await this.refresh();
    } catch (error) {
      if (grantedByThisCreate) {
        await this.rollbackUnusedHostPermission(endpoint.hostPermission);
      }
      this.setStatus(String(error), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.el.list) return;
    try {
      const [destinationsResponse, deliveriesResponse] = await Promise.all([
        sendToBackground({ type: 'LIST_INTEGRATIONS' }),
        sendToBackground({ type: 'LIST_INTEGRATION_DELIVERIES' }),
      ]);
      if (!destinationsResponse.ok) throw new Error(destinationsResponse.error);
      const deliveries = deliveriesResponse.ok ? deliveriesResponse.deliveries : [];
      const latestByDestination = new Map<string, (typeof deliveries)[number]>();
      for (const delivery of deliveries) {
        if (!latestByDestination.has(delivery.destinationId)) latestByDestination.set(delivery.destinationId, delivery);
      }
      this.el.list.replaceChildren(...destinationsResponse.destinations.map((destination) => (
        this.destinationRow(destination, latestByDestination.get(destination.id))
      )));
      if (!destinationsResponse.destinations.length) {
        const empty = this.el.document.createElement('p');
        empty.className = 'destinations-note destinations-note--quiet';
        empty.textContent = 'No external destinations configured yet.';
        this.el.list.append(empty);
      }
    } catch (error) {
      this.setStatus(`Could not load integrations: ${String(error)}`, true);
    }
  }

  private destinationRow(
    destination: IntegrationDestination,
    latest?: { id: string; state: string; revision: number; lastStatus?: number },
  ): HTMLElement {
    const row = this.el.document.createElement('article');
    row.className = 'integration-destination';
    const copy = this.el.document.createElement('div');
    copy.className = 'integration-destination__copy';
    const title = this.el.document.createElement('strong');
    title.textContent = destination.name;
    const endpoint = this.el.document.createElement('span');
    endpoint.textContent = destination.endpoint;
    const meta = this.el.document.createElement('small');
    const delivery = latest
      ? ` · last ${latest.state} r${latest.revision}${latest.lastStatus ? ` · HTTP ${latest.lastStatus}` : ''}`
      : '';
    meta.textContent = `${destination.enabled ? 'Active' : 'Disabled'}${delivery}`;
    copy.append(title, endpoint, meta);

    const actions = this.el.document.createElement('div');
    actions.className = 'integration-destination__actions';
    const test = this.el.document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test';
    const media = this.el.document.createElement('div');
    media.className = 'integration-media';
    media.hidden = !destination.media;
    const mediaLabel = this.el.document.createElement('label');
    mediaLabel.textContent = 'Media bearer (issued separately by the receiver)';
    const mediaBearer = this.el.document.createElement('input');
    mediaBearer.type = 'password';
    mediaBearer.autocomplete = 'new-password';
    mediaBearer.placeholder = 'Paste dedicated media token';
    mediaBearer.setAttribute('aria-label', `Media bearer for ${destination.name}`);
    mediaLabel.append(mediaBearer);
    const saveMedia = this.el.document.createElement('button');
    saveMedia.type = 'button';
    saveMedia.textContent = destination.media ? 'Replace media token' : 'Enable media';
    saveMedia.addEventListener('click', () => void this.configureMedia(destination, mediaBearer, saveMedia));
    media.append(mediaLabel, saveMedia);
    test.addEventListener('click', () => void this.test(destination, test, false, media));
    const send = this.el.document.createElement('button');
    send.type = 'button';
    send.textContent = 'Send recording';
    send.disabled = !destination.enabled || !this.el.recording?.value;
    send.addEventListener('click', () => void this.send(destination, send));
    const retry = this.el.document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry last delivery';
    retry.hidden = !destination.enabled || (latest?.state !== 'failed' && latest?.state !== 'action-required');
    retry.addEventListener('click', () => {
      if (latest) void this.retry(destination, latest.id, retry);
    });
    const automation = this.el.document.createElement('button');
    automation.type = 'button';
    automation.textContent = destination.enabled ? 'Disable automation' : 'Enable automation';
    automation.addEventListener('click', () => void this.setAutomation(destination, !destination.enabled, automation));
    const disconnect = this.el.document.createElement('button');
    disconnect.type = 'button';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', () => void this.remove(destination, disconnect));
    actions.append(test, send, retry, automation, disconnect);
    row.append(copy, actions, media);
    return row;
  }

  private async configureMedia(destination: IntegrationDestination, input: HTMLInputElement, button: HTMLButtonElement): Promise<void> {
    // Remove the plaintext from the page immediately; only the background's
    // integration secret store receives it, after a fresh signed discovery.
    const bearer = input.value;
    input.value = '';
    if (!bearer.trim()) {
      this.setStatus('Enter the dedicated media token issued by the receiver.', true);
      return;
    }
    button.disabled = true;
    try {
      const discovery = await sendToBackground({ type: 'TEST_INTEGRATION', destinationId: destination.id });
      if (!discovery.ok || !discovery.result.ok || !discovery.result.mediaCapability) {
        throw new Error('Test this media-capable receiver before saving its token.');
      }
      const patterns = discovery.result.mediaCapability.upload.origins
        .map((origin) => `https://${new URL(origin).hostname}/*`);
      for (const pattern of patterns) {
        if (!await containsHostPermission(pattern)) {
          throw new Error('Grant storage access with Test → Grant storage access before enabling media.');
        }
      }
      const response = await sendToBackground({ type: 'CONFIGURE_INTEGRATION_MEDIA', destinationId: destination.id, bearer });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(`${destination.name}: media credential saved. The previous token, if any, was replaced.`);
      await this.refresh();
    } catch (error) {
      this.setStatus(`Could not configure media: ${String(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  private async retry(
    destination: IntegrationDestination,
    deliveryId: string,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    this.setStatus(`Retrying the last delivery to ${destination.name}…`);
    try {
      const response = await sendToBackground({
        type: 'RETRY_INTEGRATION_DELIVERY',
        deliveryId,
      });
      if (!response.ok) throw new Error(response.error);
      const delivery = response.delivery;
      this.setStatus(
        `${destination.name}: ${delivery.state} · ${delivery.eventType} · revision ${delivery.revision}`
        + (delivery.lastStatus ? ` · HTTP ${delivery.lastStatus}` : ''),
        delivery.state !== 'delivered' && delivery.state !== 'retrying',
      );
      await this.refresh();
    } catch (error) {
      this.setStatus(`Retry failed: ${String(error)}`, true);
      button.disabled = false;
    }
  }

  /** The wizard's copy step; a browser that refuses the clipboard gets the text selected instead. */
  private async copySecret(): Promise<void> {
    const input = this.el.secretValue;
    if (!input?.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      this.setStatus('Signing secret copied. Paste it into the receiver, then test the connection.');
    } catch {
      input.focus();
      input.select();
      this.setStatus('Copy the selected signing secret into the receiver, then test the connection.');
    }
  }

  private async test(destination: IntegrationDestination, button: HTMLButtonElement, wizard = false, media?: HTMLElement): Promise<void> {
    button.disabled = true;
    this.setStatus(`Testing ${destination.name}…`);
    try {
      const response = await sendToBackground({ type: 'TEST_INTEGRATION', destinationId: destination.id });
      if (!response.ok) throw new Error(response.error);
      if (response.result.ok && response.result.mediaCapability) {
        if (media) media.hidden = false;
        const origins = response.result.mediaCapability.upload.origins;
        const patterns = origins.map((origin) => `https://${new URL(origin).hostname}/*`);
        const missing: string[] = [];
        for (const pattern of patterns) {
          if (!await containsHostPermission(pattern)) missing.push(pattern);
        }
        this.setStatus(`${destination.name}: media-capable connection verified (HTTP 200).`
          + (missing.length ? ' Grant storage access before enabling media uploads.' : ' Storage access granted.'));
        if (missing.length && this.el.status) {
          const grant = this.el.document.createElement('button');
          grant.type = 'button';
          grant.textContent = 'Grant storage access';
          grant.addEventListener('click', () => {
            // Call Chrome's permission API directly from this user gesture.
            void requestHostPermissions(missing).then((allowed) => {
              this.setStatus(allowed
                ? `${destination.name}: storage access granted.`
                : `${destination.name}: storage access declined; media uploads remain disabled.`, !allowed);
            }).catch((error) => this.setStatus(`Storage permission failed: ${String(error)}`, true));
          });
          this.el.status.append(' ', grant);
        }
        return;
      }
      if (response.result.capabilityError) {
        this.setStatus(`${destination.name}: receiver returned an unsupported media capability document.`, true);
        return;
      }
      this.setStatus(response.result.ok
        ? wizard
          ? `\u2713 ${destination.name} connected`
          : `${destination.name}: connection test succeeded (HTTP ${response.result.status}).`
        : `${destination.name}: receiver returned HTTP ${response.result.status}.`, !response.result.ok);
    } catch (error) {
      this.setStatus(`Test failed: ${String(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  private async send(destination: IntegrationDestination, button: HTMLButtonElement): Promise<void> {
    const recordingId = this.el.recording?.value;
    if (!recordingId) return;
    button.disabled = true;
    this.setStatus(`Sending current snapshot to ${destination.name}…`);
    try {
      const response = await sendToBackground({
        type: 'SEND_RECORDING_TO_INTEGRATION',
        destinationId: destination.id,
        recordingId,
      });
      if (!response.ok) {
        if (response.payloadTooLarge) {
          const size = response.payloadTooLarge;
          this.setStatus(
            `Payload too large: ${formatBytes(size.totalBytes)} JSON `
            + `(${formatBytes(size.transcriptBytes)} transcript); `
            + `limit ${formatBytes(size.maxBytes)}.`,
            true,
          );
          return;
        }
        throw new Error(response.error);
      }
      const delivery = response.delivery;
      const payloadSize = delivery.totalBytes != null
        ? ` · ${formatBytes(delivery.totalBytes)} JSON`
          + (delivery.transcriptBytes != null ? ` · ${formatBytes(delivery.transcriptBytes)} transcript` : '')
        : '';
      this.setStatus(
        `${destination.name}: ${delivery.state} · ${delivery.eventType} · revision ${delivery.revision}`
        + (delivery.lastStatus ? ` · HTTP ${delivery.lastStatus}` : '')
        + payloadSize,
        delivery.state !== 'delivered',
      );
      await this.refresh();
    } catch (error) {
      this.setStatus(`Send failed: ${String(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  private async setAutomation(
    destination: IntegrationDestination,
    enabled: boolean,
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    this.setStatus(`${enabled ? 'Enabling' : 'Disabling'} automation for ${destination.name}…`);
    try {
      const response = await sendToBackground({
        type: 'SET_INTEGRATION_ENABLED',
        destinationId: destination.id,
        enabled,
      });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(enabled
        ? `Automation enabled for ${destination.name}. New recordings can use this destination again.`
        : `Automation disabled for ${destination.name}. New and pending exports are stopped; existing remote media stays playable while the connection is retained.`);
      this.onDestinationsChanged();
      await this.refresh();
    } catch (error) {
      this.setStatus(`Could not ${enabled ? 'enable' : 'disable'} automation: ${String(error)}`, true);
      button.disabled = false;
    }
  }

  private async remove(destination: IntegrationDestination, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const impact = await sendToBackground({
        type: 'GET_INTEGRATION_DISCONNECT_IMPACT',
        destinationId: destination.id,
      });
      if (!impact.ok) throw new Error(impact.error);
      const count = impact.affectedRecordings;
      const playback = count === 1
        ? '1 recording has a remote media copy through this connection.'
        : `${count} recordings have remote media copies through this connection.`;
      const confirmed = window.confirm(
        `Disconnect ${destination.name}?\n\n`
        + `${playback} Disconnecting removes the stored credentials, so those remote copies will no longer play in the extension. `
        + 'Any pending exports are stopped. Data and media already stored by the receiver are not deleted.',
      );
      if (!confirmed) {
        button.disabled = false;
        this.setStatus(`Kept ${destination.name} connected.`);
        return;
      }
      this.setStatus(`Disconnecting ${destination.name}…`);
      const response = await sendToBackground({
        type: 'DELETE_INTEGRATION',
        destinationId: destination.id,
      });
      if (!response.ok) throw new Error(response.error);
      if (response.hostPermissionCleanup === 'failed') {
        this.setStatus(
          `Disconnected ${destination.name} and removed its stored credentials. Receiver data/media were not deleted, but the browser host permission could not be cleaned up.`,
          true,
        );
      } else {
        this.setStatus(`Disconnected ${destination.name} and removed its stored credentials. Receiver data/media were not deleted.`);
      }
      this.onDestinationsChanged();
      await this.refresh();
    } catch (error) {
      this.setStatus(`Disconnect failed: ${String(error)}`, true);
      button.disabled = false;
    }
  }

  private async rollbackUnusedHostPermission(pattern: string): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_INTEGRATIONS' });
      if (!response.ok) return;
      const stillUsed = response.destinations.some((destination) => (
        normalizeWebhookEndpoint(destination.endpoint).hostPermission === pattern
      ));
      if (!stillUsed) await removeHostPermission(pattern);
    } catch {
      // Retaining an optional permission is safer than revoking one whose
      // remaining use could not be established.
    }
  }

  private async loadRecordings(): Promise<void> {
    if (!this.el.recording) return;
    try {
      const response = await sendToBackground({ type: 'LIST_INTEGRATION_RECORDINGS' });
      if (!response.ok) throw new Error(response.error);
      this.el.recording.replaceChildren(...response.recordings.map((entry) => {
        const option = this.el.document.createElement('option');
        option.value = entry.id;
        option.disabled = !entry.available;
        option.textContent = entry.available
          ? entry.name
          : `${entry.name} — unavailable: missing recording context`;
        return option;
      }));
      const firstAvailable = response.recordings.find((entry) => entry.available);
      if (firstAvailable) this.el.recording.value = firstAvailable.id;
      else this.el.recording.selectedIndex = -1;
    } catch (error) {
      this.setStatus(`Could not load recordings: ${String(error)}`, true);
    }
  }

  private readPolicy(): IntegrationDataPolicy {
    const selected = new Set(
      Array.from(this.el.policyInputs)
        .filter((input) => input.checked)
        .map((input) => input.dataset.integrationCreatePolicy),
    );
    return canonicalizeIntegrationDataPolicy({
      metadata: true,
      meetingIdentity: selected.has('meetingIdentity'),
      userNote: selected.has('userNote'),
      notations: selected.has('notations'),
      transcript: selected.has('transcript'),
      analysis: selected.has('analysis'),
      artifactMetadata: selected.has('artifactMetadata'),
      artifactLinks: selected.has('artifactLinks'),
      transcriptSpeakers: normalizeSpeakerPolicy(this.el.speakerPolicy?.value),
    });
  }

  private readRequestAuth(): IntegrationRequestAuthDraft {
    const type = this.el.authType?.value;
    if (type === 'bearer') {
      const value = this.el.authValue?.value ?? '';
      if (!value) throw new Error('Integration request credential is required');
      return { type, value };
    }
    if (type === 'api-key') {
      const value = this.el.authValue?.value ?? '';
      if (!value) throw new Error('Integration request credential is required');
      return {
        type,
        header: normalizeWebhookApiKeyHeader(this.el.authHeader?.value ?? ''),
        value,
      };
    }
    return { type: 'none' };
  }

  private syncAuthFields(): void {
    const type = this.el.authType?.value ?? 'none';
    if (this.el.authHeader) this.el.authHeader.hidden = type !== 'api-key';
    if (this.el.authValue) {
      this.el.authValue.hidden = type === 'none';
      this.el.authValue.placeholder = type === 'bearer' ? 'Bearer token' : 'API key value';
    }
  }

  private setBusy(busy: boolean): void {
    if (this.el.add) this.el.add.disabled = busy;
  }

  private setStatus(message: string, error = false): void {
    if (!this.el.status) return;
    this.el.status.textContent = message;
    this.el.status.dataset.error = String(error);
  }
}

function normalizeSpeakerPolicy(value: string | undefined): TranscriptSpeakerPolicy {
  return value === 'names' || value === 'omit' ? value : 'pseudonyms';
}
