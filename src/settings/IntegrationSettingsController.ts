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
} from '../platform/chrome/permissions';
import { sendToBackground } from '../shared/messages';
import { formatBytes } from '../shared/format';

type Elements = {
  document: Document;
  name: HTMLInputElement | null;
  endpoint: HTMLInputElement | null;
  routing: HTMLSelectElement | null;
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
};

export class IntegrationSettingsController {
  constructor(private readonly el: Elements) {}

  static fromDocument(doc: Document): IntegrationSettingsController {
    return new IntegrationSettingsController({
      document: doc,
      name: doc.getElementById('integration-name') as HTMLInputElement | null,
      endpoint: doc.getElementById('integration-endpoint') as HTMLInputElement | null,
      routing: doc.getElementById('integration-routing') as HTMLSelectElement | null,
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
    });
  }

  async init(): Promise<void> {
    this.el.add?.addEventListener('click', () => void this.create());
    this.el.authType?.addEventListener('change', () => this.syncAuthFields());
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
          routingDefault: normalizeRouting(this.el.routing?.value),
          dataPolicy: this.readPolicy(),
          requestAuth,
        },
      });
      if (!response.ok) throw new Error(response.error);
      if (this.el.secretValue) this.el.secretValue.value = response.created.signingSecret;
      if (this.el.secretPanel) this.el.secretPanel.hidden = false;
      if (this.el.authValue) this.el.authValue.value = '';
      this.setStatus(`Added ${response.created.destination.name}. Save the signing secret now; later it can only be rotated.`);
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
    latest?: { state: string; revision: number; lastStatus?: number },
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
    meta.textContent = `${destination.routingDefault.toUpperCase()} · ${destination.enabled ? 'Active' : 'Disabled'}${delivery}`;
    copy.append(title, endpoint, meta);

    const actions = this.el.document.createElement('div');
    actions.className = 'integration-destination__actions';
    const test = this.el.document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test';
    test.addEventListener('click', () => void this.test(destination, test));
    const send = this.el.document.createElement('button');
    send.type = 'button';
    send.textContent = 'Send recording';
    send.disabled = !this.el.recording?.value;
    send.addEventListener('click', () => void this.send(destination, send));
    const remove = this.el.document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => void this.remove(destination, remove));
    actions.append(test, send, remove);
    row.append(copy, actions);
    return row;
  }

  private async test(destination: IntegrationDestination, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.setStatus(`Testing ${destination.name}…`);
    try {
      const response = await sendToBackground({ type: 'TEST_INTEGRATION', destinationId: destination.id });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(response.result.ok
        ? `${destination.name}: connection test succeeded (HTTP ${response.result.status}).`
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

  private async remove(destination: IntegrationDestination, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.setStatus(`Deleting ${destination.name}…`);
    try {
      const response = await sendToBackground({
        type: 'DELETE_INTEGRATION',
        destinationId: destination.id,
      });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(`Deleted ${destination.name} and its stored credentials.`);
      await this.refresh();
    } catch (error) {
      this.setStatus(`Delete failed: ${String(error)}`, true);
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

function normalizeRouting(value: string | undefined): 'manual' | 'auto' | 'review' {
  return value === 'auto' || value === 'review' ? value : 'manual';
}

function normalizeSpeakerPolicy(value: string | undefined): TranscriptSpeakerPolicy {
  return value === 'names' || value === 'omit' ? value : 'pseudonyms';
}
