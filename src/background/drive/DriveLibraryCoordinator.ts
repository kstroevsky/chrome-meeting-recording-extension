import { loadExtensionSettingsFromStorage } from '../../shared/settings';
import { DRIVE_DEFAULT_DESTINATION_NAME } from '../../shared/settings';
import type { RecordingHistoryCursor, RecordingHistoryEntry } from '../../shared/recordingHistory';
import { DriveArtifactResolver } from './DriveArtifactResolver';
import { DriveDestinationFiler } from './DriveDestinationFiler';
import { DriveRootFolder } from './DriveRootFolder';
import { fetchDriveTokenWithFallback } from './driveAuth';
import { plannedFolderRenames } from './driveFolderNameRepair';
import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

type DriveFolderPorts =
  ConstructorParameters<typeof DriveDestinationFiler>[0]
  & ConstructorParameters<typeof DriveRootFolder>[0];

const DRIVE_DESTINATIONS_GATHERED_KEY = 'driveDestinationsGathered';

export class DriveLibraryCoordinator {
  readonly artifacts: DriveArtifactResolver;

  private readonly folders: DriveDestinationFiler;
  private readonly rootFolder: DriveRootFolder;
  private readonly folderPorts: DriveFolderPorts;

  constructor(
    private readonly historyRepository: RecordingHistoryRepository,
    private readonly history: RecordingHistoryService,
    private readonly logger: Logger,
  ) {
    this.artifacts = new DriveArtifactResolver({
      getMetadata: async (fileId) => {
        const { status, body } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,trashed`);
        if (status === 404) return null;
        if (status !== 200) throw new Error(`Drive metadata ${status}`);
        return body;
      },
      listFolder: async (folderId) => {
        const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const { status, body } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size,trashed)&pageSize=200`);
        if (status !== 200) throw new Error(`Drive folder listing ${status}`);
        return body?.files ?? [];
      },
      warn: logger.warn,
    });

    this.folderPorts = {
      getFolder: async (id: string) => {
        const { status, body } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,parents`);
        return status === 200 ? body : null;
      },
      findFolder: async (name: string, parentId: string | null) => {
        const query = encodeURIComponent(
          `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`
          + ` and '${(parentId ?? 'root').replace(/'/g, "\\'")}' in parents and trashed = false`);
        const { status, body } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,parents)&pageSize=1`);
        return status === 200 ? (body?.files?.[0] ?? null) : null;
      },
      createFolder: async (name: string, parentId: string | null) => {
        const { status, body } = await this.driveJson('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            ...(parentId ? { parents: [parentId] } : {}),
          }),
        });
        if (status !== 200) throw new Error(`Could not create the destination folder (${status})`);
        return body;
      },
      renameFolder: async (folderId: string, name: string) => {
        const { status } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name`,
          { method: 'PATCH', body: JSON.stringify({ name }) });
        if (status !== 200) throw new Error(`Could not rename the folder in Google Drive (${status})`);
      },
      moveFolder: async (folderId: string, addParent: string, removeParents: string[]) => {
        const params = new URLSearchParams({ addParents: addParent, fields: 'id,parents' });
        if (removeParents.length) params.set('removeParents', removeParents.join(','));
        const { status } = await this.driveJson(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${params}`,
          { method: 'PATCH', body: '{}' });
        if (status !== 200) throw new Error(`Could not move the recording folder (${status})`);
      },
      warn: logger.warn,
    };

    this.folders = new DriveDestinationFiler(this.folderPorts);
    this.rootFolder = new DriveRootFolder(this.folderPorts);
  }

  async fileRecordingToDestination(recordingId: string, presetId: string | null): Promise<void> {
    const entry = await this.historyRepository.get(recordingId);
    if (!entry || entry.deletedAt) throw new Error('This recording is no longer available');
    if (!entry.driveFolderId) throw new Error('This recording has no Google Drive folder to move');

    const settings = await loadExtensionSettingsFromStorage();
    const preset = presetId
      ? settings.storage.driveFolderPresets.find((candidate) => candidate.id === presetId)
      : undefined;
    if (presetId && !preset) throw new Error('That destination no longer exists');

    const result = await this.folders.file(
      entry.driveFolderId,
      preset?.name ?? DRIVE_DEFAULT_DESTINATION_NAME,
      settings.storage.driveRootFolderName,
    );
    if (result.status === 'missing') throw new Error('This recording\u2019s folder is no longer in Google Drive');
    await this.history.setDriveDestination(recordingId, presetId);
    void this.tidyOnce();
  }

  renameRootFolder(from: string, to: string) {
    return this.rootFolder.rename(from, to);
  }

  async tidyOnce(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get?.(DRIVE_DESTINATIONS_GATHERED_KEY);
      if (stored?.[DRIVE_DESTINATIONS_GATHERED_KEY]) return;
      const result = await this.gatherDestinations();
      const repair = await this.repairFolderNames();
      if (result.failed > 0 || repair.failed > 0) return;
      if (result.moved.length) {
        this.logger.log('Moved destination folders into the recordings folder:', result.moved.join(', '));
      }
      await chrome.storage?.local?.set?.({ [DRIVE_DESTINATIONS_GATHERED_KEY]: true });
    } catch (error) {
      this.logger.warn('Could not tidy the Drive destination folders:', error);
    }
  }

  private async driveJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const res = await fetchDriveTokenWithFallback();
    if (!res.ok) throw new Error(res.error);
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${res.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json().catch(() => null),
    };
  }

  private async gatherDestinations() {
    const settings = await loadExtensionSettingsFromStorage();
    const folderIds = new Set<string>();
    let cursor: RecordingHistoryCursor | undefined;
    do {
      const page = await this.historyRepository.listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const entry of page.entries) {
        if (!entry.deletedAt && entry.driveFolderId) folderIds.add(entry.driveFolderId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return await this.rootFolder.gather(
      [...folderIds],
      settings.storage.driveFolderPresets.map((preset) => preset.name),
      settings.storage.driveRootFolderName,
    );
  }

  private async repairFolderNames(): Promise<{ repaired: number; failed: number }> {
    const entries: RecordingHistoryEntry[] = [];
    let cursor: RecordingHistoryCursor | undefined;
    do {
      const page = await this.historyRepository.listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);

    let repaired = 0;
    let failed = 0;
    for (const rename of plannedFolderRenames(entries)) {
      try {
        await this.folderPorts.renameFolder(rename.folderId, rename.to);
        await this.historyRepository.update(rename.historyId, (current) => (
          current ? { ...current, driveFolderName: rename.to } : current
        ));
        repaired += 1;
      } catch (error) {
        this.logger.warn('Could not rename a recording folder in Google Drive:', error);
        failed += 1;
      }
    }
    if (repaired) this.logger.log(`Renamed ${repaired} recording folder(s) after the meeting they hold`);
    return { repaired, failed };
  }
}
