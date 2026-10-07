/**
 * @file settings/DestinationSettingsController.ts
 *
 * The settings page's *Save to* section (plan E3/E4): the destinations the
 * popup offers, each with where its files and its data go, and a row to add
 * one for an integration that has none. Connecting an integration below
 * already adds its destination, so the row is for one that was removed, or for
 * a second folder.
 *
 * The background owns the profiles; this page only lists, adds and removes
 * them through it, so the popup and this page can never disagree.
 */

import type { RecordingDestinationOption } from '../background/destinations/RecordingDestinationsRuntime';
import type { IntegrationDestination } from '../integrations/persistence';
import { sendToBackground } from '../shared/messages';
import { describeDestination } from '../shared/recordingDestinationLabels';
import type { FolderPreset } from '../shared/settings';
import { loadExtensionSettingsFromStorage } from '../shared/settings';

type Elements = {
  document: Document;
  list: HTMLElement | null;
  addRow: HTMLElement | null;
  integration: HTMLSelectElement | null;
  folder: HTMLSelectElement | null;
  add: HTMLButtonElement | null;
  status: HTMLElement | null;
};

type Deps = {
  localFolders: () => Promise<FolderPreset[]>;
};

export class DestinationSettingsController {
  constructor(
    private readonly el: Elements,
    private readonly deps: Deps = {
      localFolders: async () => (await loadExtensionSettingsFromStorage()).storage.localFolderPresets,
    },
  ) {}

  static fromDocument(doc: Document): DestinationSettingsController {
    return new DestinationSettingsController({
      document: doc,
      list: doc.getElementById('save-to-list'),
      addRow: doc.getElementById('save-to-add-row'),
      integration: doc.getElementById('save-to-integration') as HTMLSelectElement | null,
      folder: doc.getElementById('save-to-folder') as HTMLSelectElement | null,
      add: doc.getElementById('save-to-add') as HTMLButtonElement | null,
      status: doc.getElementById('save-to-status'),
    });
  }

  async init(): Promise<void> {
    this.el.add?.addEventListener('click', () => void this.addDestination());
    await this.refresh();
  }

  /** Re-reads the list; the integrations section calls it after it adds or deletes one. */
  async refresh(): Promise<void> {
    if (!this.el.list) return;
    try {
      const [destinationsResponse, integrationsResponse, folders] = await Promise.all([
        sendToBackground({ type: 'LIST_RECORDING_DESTINATIONS' }),
        sendToBackground({ type: 'LIST_INTEGRATIONS' }),
        this.deps.localFolders().catch(() => [] as FolderPreset[]),
      ]);
      if (!destinationsResponse.ok) throw new Error(destinationsResponse.error);
      const integrations = integrationsResponse.ok ? integrationsResponse.destinations : [];
      this.renderList(destinationsResponse.destinations);
      this.renderAddRow(destinationsResponse.destinations, integrations, folders);
    } catch (error) {
      this.setStatus(`Could not load destinations: ${String(error)}`, true);
    }
  }

  private renderList(destinations: RecordingDestinationOption[]): void {
    const doc = this.el.document;
    this.el.list!.replaceChildren(...destinations.map((option) => {
      const row = doc.createElement('article');
      row.className = 'integration-destination';
      row.classList.toggle('integration-destination--unavailable', !option.available);
      row.dataset.destinationProfile = option.id;
      const copy = doc.createElement('div');
      copy.className = 'integration-destination__copy';
      const title = doc.createElement('strong');
      title.textContent = option.name;
      const detail = doc.createElement('small');
      detail.textContent = option.kind === 'builtin' ? 'Built in' : describeDestination(option);
      copy.append(title, detail);
      row.append(copy);
      if (option.kind === 'integration') {
        const actions = doc.createElement('div');
        actions.className = 'integration-destination__actions';
        const remove = doc.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${option.name} from Save to`);
        remove.addEventListener('click', () => void this.removeDestination(option, remove));
        actions.append(remove);
        row.append(actions);
      }
      return row;
    }));
  }

  /** Offered only for integrations that no destination sends to yet. */
  private renderAddRow(
    destinations: RecordingDestinationOption[],
    integrations: IntegrationDestination[],
    folders: FolderPreset[],
  ): void {
    const doc = this.el.document;
    const routed = new Set(destinations.flatMap((option) => option.dataRoutes.map((route) => route.destinationId)));
    const candidates = integrations.filter((integration) => !routed.has(integration.id));
    if (this.el.addRow) this.el.addRow.hidden = candidates.length === 0;
    this.el.integration?.replaceChildren(...candidates.map((integration) => {
      const option = doc.createElement('option');
      option.value = integration.id;
      option.textContent = integration.name;
      return option;
    }));
    this.el.folder?.replaceChildren(
      ...[{ id: '', name: 'Files: Local downloads' }, ...folders.map((folder) => ({ id: folder.id, name: `Files: Local downloads / ${folder.name}` }))]
        .map((folder) => {
          const option = doc.createElement('option');
          option.value = folder.id;
          option.textContent = folder.name;
          return option;
        }),
    );
  }

  private async addDestination(): Promise<void> {
    const destinationId = this.el.integration?.value;
    if (!destinationId) return;
    const folderId = this.el.folder?.value || undefined;
    this.setBusy(true);
    try {
      const response = await sendToBackground({
        type: 'SAVE_RECORDING_DESTINATION',
        input: { destinationId, ...(folderId ? { localFolderPresetId: folderId } : {}) },
      });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(`Added ${response.profile.name}. Pick it under Save to before you record.`);
      await this.refresh();
    } catch (error) {
      this.setStatus(`Could not add the destination: ${String(error)}`, true);
    } finally {
      this.setBusy(false);
    }
  }

  private async removeDestination(option: RecordingDestinationOption, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const response = await sendToBackground({ type: 'REMOVE_RECORDING_DESTINATION', profileId: option.id });
      if (!response.ok) throw new Error(response.error);
      // Recordings already started with it keep their own routing; only new ones lose the choice.
      this.setStatus(`Removed ${option.name} from Save to. Recordings already made with it are not affected.`);
      await this.refresh();
    } catch (error) {
      this.setStatus(`Could not remove ${option.name}: ${String(error)}`, true);
      button.disabled = false;
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
