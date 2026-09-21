import type { DownloadSettledResult } from '../../../platform/chrome/downloads';
import type {
  RecordingArtifactKind,
  RecordingStream,
  StorageMode,
  UploadJob,
} from '../../../shared/recording';
import type {
  ArtifactLocation,
  RecordingHistoryCursor,
  RecordingHistoryEntry,
  RecordingHistoryPage,
} from '../../../shared/recordingHistory';
import { LocalDeliveryCoordinator } from './LocalDeliveryCoordinator';
import { RecordingDelivery } from './RecordingDelivery';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';
import type { PendingRecordingFile } from './RecordingHistoryState';
import {
  RecordingRename,
  type DriveRecordingRenamer,
} from './RecordingRename';

export type { DriveRecordingRenamer, DriveRenameResult } from './RecordingRename';

/** Public owner of recording-history behavior and its focused collaborators. */
export class RecordingHistoryService {
  private readonly delivery: RecordingDelivery;
  private readonly localDelivery: LocalDeliveryCoordinator;
  private readonly renameCommands: RecordingRename;

  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly openDownload: (downloadId: number) => Promise<void>,
    private readonly now: () => number = Date.now,
    renameDriveResources?: DriveRecordingRenamer,
    private readonly onRemoved?: (id: string) => Promise<void>,
    private readonly deleteRetainedMedia?: (
      keys: string[],
      historyId: string,
    ) => Promise<void>,
  ) {
    this.delivery = new RecordingDelivery(repository, now);
    this.localDelivery = new LocalDeliveryCoordinator(repository);
    this.renameCommands = new RecordingRename(repository, renameDriveResources);
  }

  async listPage(cursor?: RecordingHistoryCursor): Promise<RecordingHistoryPage> {
    return this.repository.listPage({ cursor });
  }

  async list(): Promise<RecordingHistoryEntry[]> {
    return (await this.listPage()).entries;
  }

  async rename(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    return this.renameCommands.rename(id, name);
  }

  async setDuration(
    id: string,
    durationMs: number | undefined,
  ): Promise<RecordingHistoryEntry | undefined> {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
      return undefined;
    }
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return { ...current, durationMs };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  async setNote(
    id: string,
    note: string,
  ): Promise<RecordingHistoryEntry | undefined> {
    const normalized = note.trim();
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return normalized
        ? { ...current, note: normalized }
        : { ...current, note: undefined };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    let retainedKeys: string[] = [];
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      removed = true;
      retainedKeys = current.files.flatMap((file) => file.locations
        .filter((location) => location.kind === 'opfs')
        .map((location) => location.key));
      return { ...current, deletedAt: this.now() };
    });

    if (removed && this.onRemoved) await this.onRemoved(id).catch(() => {});
    if (removed && retainedKeys.length && this.deleteRetainedMedia) {
      await this.deleteRetainedMedia(retainedKeys, id).catch(() => {});
    }
    return removed;
  }

  async createPending(
    historyId: string,
    files: PendingRecordingFile[],
    storageMode: StorageMode,
  ): Promise<void> {
    await this.delivery.createPending(historyId, files, storageMode);
  }

  async applyUploadJob(job: UploadJob): Promise<void> {
    await this.delivery.applyUploadJob(job);
  }

  async applyTerminalUploadJob(job: UploadJob): Promise<void> {
    await this.delivery.applyTerminalUploadJob(job);
  }

  async localSaveSettled(
    historyId: string,
    stream: RecordingStream,
    downloadId: number | undefined,
    settled: DownloadSettledResult,
    error?: string,
    kind?: RecordingArtifactKind,
  ): Promise<void> {
    await this.localDelivery.localSaveSettled(
      historyId,
      stream,
      downloadId,
      settled,
      error,
      kind,
    );
  }

  async recordArtifactLocation(
    historyId: string,
    fileId: string,
    location: ArtifactLocation,
  ): Promise<void> {
    await this.localDelivery.recordArtifactLocation(historyId, fileId, location);
  }

  async dropArtifactLocation(
    historyId: string,
    fileId: string,
    key: string,
  ): Promise<void> {
    await this.localDelivery.dropArtifactLocation(historyId, fileId, key);
  }

  async setDriveDestination(historyId: string, presetId: string | null): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const { driveFolderPresetId: _dropped, ...rest } = current;
      return presetId ? { ...rest, driveFolderPresetId: presetId } : rest;
    });
  }

  async setLocalFolder(
    historyId: string,
    folderName: string | undefined,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const { localFolderName: _dropped, ...rest } = current;
      return folderName ? { ...rest, localFolderName: folderName } : rest;
    });
  }

  async openLocalFile(recordingId: string, fileId: string): Promise<void> {
    const entry = await this.repository.get(recordingId);
    const file = entry && !entry.deletedAt
      ? entry.files.find((candidate) => candidate.id === fileId)
      : undefined;
    if (!file?.downloadId) throw new Error('This local file is no longer available');
    await this.openDownload(file.downloadId);
  }
}
