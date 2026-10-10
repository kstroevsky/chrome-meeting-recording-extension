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
 * them through it, so the popup and this page can never disagree. M3 lets one
 * profile combine a local/Drive file target with several automatic data routes.
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
  name: HTMLInputElement | null;
  media: HTMLSelectElement | null;
  integration: HTMLSelectElement | null;
  folder: HTMLSelectElement | null;
  add: HTMLButtonElement | null;
  status: HTMLElement | null;
};

type Deps = {
  folders: () => Promise<{ local: FolderPreset[]; drive: FolderPreset[] }>;
};

export class DestinationSettingsController {
  private integrations: IntegrationDestination[] = [];

  constructor(
    private readonly el: Elements,
    private readonly deps: Deps = {
      folders: async () => {
        const settings = await loadExtensionSettingsFromStorage();
        return {
          local: settings.storage.localFolderPresets,
          drive: settings.storage.driveFolderPresets,
        };
      },
    },
  ) {}

  static fromDocument(doc: Document): DestinationSettingsController {
    return new DestinationSettingsController({
      document: doc,
      list: doc.getElementById('save-to-list'),
      addRow: doc.getElementById('save-to-add-row'),
      name: doc.getElementById('save-to-name') as HTMLInputElement | null,
      media: doc.getElementById('save-to-media') as HTMLSelectElement | null,
      integration: doc.getElementById('save-to-integration') as HTMLSelectElement | null,
      folder: doc.getElementById('save-to-folder') as HTMLSelectElement | null,
      add: doc.getElementById('save-to-add') as HTMLButtonElement | null,
      status: doc.getElementById('save-to-status'),
    });
  }

  async init(): Promise<void> {
    this.el.add?.addEventListener('click', () => void this.addDestination());
    this.el.media?.addEventListener('change', () => void this.refreshFolders());
    await this.refresh();
  }

  /** Re-reads the list; the integrations section calls it after it adds or deletes one. */
  async refresh(): Promise<void> {
    if (!this.el.list) return;
    try {
      const [destinationsResponse, integrationsResponse, folders] = await Promise.all([
        sendToBackground({ type: 'LIST_RECORDING_DESTINATIONS' }),
        sendToBackground({ type: 'LIST_INTEGRATIONS' }),
        this.deps.folders().catch(() => ({ local: [] as FolderPreset[], drive: [] as FolderPreset[] })),
      ]);
      if (!destinationsResponse.ok) throw new Error(destinationsResponse.error);
      const integrations = integrationsResponse.ok ? integrationsResponse.destinations : [];
      this.integrations = integrations;
      this.renderList(destinationsResponse.destinations);
      this.renderAddRow(integrations, folders);
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
      if (option.kind === 'custom') {
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

  private renderAddRow(
    integrations: IntegrationDestination[],
    folders: { local: FolderPreset[]; drive: FolderPreset[] },
  ): void {
    const doc = this.el.document;
    if (this.el.addRow) this.el.addRow.hidden = false;
    if (this.el.media) {
      const selected = this.el.media.value;
      this.el.media.replaceChildren(
        ...[
          { value: 'local', label: 'Files: Local downloads' },
          { value: 'drive', label: 'Files: Google Drive' },
          ...integrations
            .filter((integration) => integration.enabled && integration.media)
            .map((integration) => ({ value: `external:${integration.id}`, label: `Files: ${integration.name}` })),
        ].map(({ value, label }) => {
          const option = doc.createElement('option');
          option.value = value;
          option.textContent = label;
          return option;
        }),
      );
      if (Array.from(this.el.media.options).some((option) => option.value === selected)) this.el.media.value = selected;
    }
    this.el.integration?.replaceChildren(...integrations.map((integration) => {
      const option = doc.createElement('option');
      option.value = integration.id;
      option.textContent = integration.name;
      return option;
    }));
    this.renderFolderOptions(folders);
  }

  private async addDestination(): Promise<void> {
    const mediaValue = this.el.media?.value ?? 'local';
    const folderId = this.el.folder?.value || undefined;
    const destinationIds = Array.from(this.el.integration?.selectedOptions ?? []).map((option) => option.value);
    const name = this.el.name?.value.trim() || undefined;
    const externalDestinationId = mediaValue.startsWith('external:') ? mediaValue.slice('external:'.length) : undefined;
    const mediaTarget = externalDestinationId
      ? { kind: 'external' as const, destinationId: externalDestinationId }
      : { kind: mediaValue === 'drive' ? 'drive' as const : 'local' as const, ...(folderId ? { folderPresetId: folderId } : {}) };
    this.setBusy(true);
    try {
      const response = await sendToBackground({
        type: 'SAVE_RECORDING_DESTINATION',
        input: {
          ...(name ? { name } : {}),
          mediaTarget,
          dataRoutes: destinationIds.map((destinationId) => ({ destinationId, mode: 'auto' as const })),
        },
      });
      if (!response.ok) throw new Error(response.error);
      this.setStatus(`Added ${response.profile.name}. Pick it under Save to before you record.`);
      if (this.el.name) this.el.name.value = '';
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

  private async refreshFolders(): Promise<void> {
    try {
      const folders = await this.deps.folders();
      this.renderFolderOptions(folders);
    } catch {
      this.renderFolderOptions({ local: [], drive: [] });
    }
  }

  private renderFolderOptions(folders: { local: FolderPreset[]; drive: FolderPreset[] }): void {
    if (!this.el.folder) return;
    const doc = this.el.document;
    const mediaValue = this.el.media?.value ?? 'local';
    if (mediaValue.startsWith('external:')) {
      const destinationId = mediaValue.slice('external:'.length);
      const name = this.integrations.find((integration) => integration.id === destinationId)?.name ?? 'External service';
      const option = doc.createElement('option');
      option.value = '';
      option.textContent = `Files: ${name}`;
      this.el.folder.replaceChildren(option);
      this.el.folder.disabled = true;
      return;
    }
    this.el.folder.disabled = false;
    const mediaKind = mediaValue === 'drive' ? 'drive' : 'local';
    const base = mediaKind === 'drive' ? 'Google Drive' : 'Local downloads';
    const presets = mediaKind === 'drive' ? folders.drive : folders.local;
    this.el.folder.replaceChildren(
      ...[{ id: '', name: `Files: ${base}` }, ...presets.map((folder) => ({ id: folder.id, name: `Files: ${base} / ${folder.name}` }))]
        .map((folder) => {
          const option = doc.createElement('option');
          option.value = folder.id;
          option.textContent = folder.name;
          return option;
        }),
    );
  }

  private setStatus(message: string, error = false): void {
    if (!this.el.status) return;
    this.el.status.textContent = message;
    this.el.status.dataset.error = String(error);
  }
}
