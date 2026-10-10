import type { DownloadSettledResult } from '../../../platform/chrome/downloads';
import type {
  RecordingArtifactKind,
  RecordingStream,
  UploadJob,
} from '../../../shared/recording';
import type {
  ArtifactLocation,
  ArtifactDeliveryTarget,
  RecordingHistoryCursor,
  RecordingHistoryEntry,
  RecordingHistoryPage,
  RetainedMediaReleaseTarget,
} from '../../../shared/recordingHistory';
import { LocalDeliveryHistory } from './LocalDeliveryHistory';
import { RecordingDelivery } from './RecordingDelivery';
import { RecordingHistoryCleanup } from './RecordingHistoryCleanup';
import { RecordingHistoryMetadata } from './RecordingHistoryMetadata';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';
import type { PendingRecordingFile } from './RecordingHistoryState';
import {
  RecordingRename,
  type DriveRecordingRenamer,
} from './RecordingRename';
import { VerifiedRetainedMediaRelease } from './VerifiedRetainedMediaRelease';

export type { DriveRecordingRenamer, DriveRenameResult } from './RecordingRename';

/** Public owner of recording-history behavior and its focused collaborators. */
export class RecordingHistoryService {
  private readonly delivery: RecordingDelivery;
  private readonly localDelivery: LocalDeliveryHistory;
  private readonly renameCommands: RecordingRename;
  private readonly cleanup: RecordingHistoryCleanup;
  private readonly retainedMediaRelease: VerifiedRetainedMediaRelease;
  private readonly metadata: RecordingHistoryMetadata;

  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    openDownload: (downloadId: number) => Promise<void>,
    private readonly now: () => number = Date.now,
    renameDriveResources?: DriveRecordingRenamer,
    onRemoved?: (id: string) => Promise<void>,
    deleteRetainedMedia?: (
      keys: string[],
      historyId: string,
    ) => Promise<void | 'deleted' | 'deferred'>,
    warnCleanup: (message: string, error: unknown) => void = () => {},
    private readonly onChanged?: (recordingId: string) => void,
  ) {
    this.delivery = new RecordingDelivery(repository, now);
    this.localDelivery = new LocalDeliveryHistory(repository, openDownload);
    this.renameCommands = new RecordingRename(repository, renameDriveResources);
    this.cleanup = new RecordingHistoryCleanup(repository, onRemoved, deleteRetainedMedia, warnCleanup);
    this.metadata = new RecordingHistoryMetadata(repository, onChanged);
    this.retainedMediaRelease = new VerifiedRetainedMediaRelease(
      repository, now, deleteRetainedMedia, warnCleanup, onChanged,
    );
  }

  async listPage(cursor?: RecordingHistoryCursor): Promise<RecordingHistoryPage> {
    return this.repository.listPage({ cursor });
  }

  async get(id: string): Promise<RecordingHistoryEntry | undefined> {
    const entry = await this.repository.get(id);
    return entry?.deletedAt ? undefined : entry;
  }

  async list(): Promise<RecordingHistoryEntry[]> {
    return (await this.listPage()).entries;
  }

  async rename(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    const updated = await this.renameCommands.rename(id, name);
    if (updated) this.onChanged?.(id);
    return updated;
  }

  async setDuration(
    id: string,
    durationMs: number | undefined,
  ): Promise<RecordingHistoryEntry | undefined> {
    return this.metadata.setDuration(id, durationMs);
  }

  async setNote(
    id: string,
    note: string,
  ): Promise<RecordingHistoryEntry | undefined> {
    return this.metadata.setNote(id, note);
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      removed = true;
      return { ...current, deletedAt: this.now(), cleanupPending: true };
    });

    if (removed) await this.cleanup.cleanupDeletedEntry(id).catch(() => {});
    return removed;
  }

  async retryPendingCleanup(): Promise<boolean> {
    const pending = await this.repository.listCleanupPending();
    let allSucceeded = true;
    for (const entry of pending) {
      try {
        await this.cleanup.cleanupDeletedEntry(entry.id, entry);
      } catch {
        allSucceeded = false;
      }
    }
    return allSucceeded;
  }

  async createPending(
    historyId: string,
    files: PendingRecordingFile[],
    requested: ArtifactDeliveryTarget,
  ): Promise<void> {
    await this.delivery.createPending(historyId, files, requested);
    this.onChanged?.(historyId);
  }

  async applyUploadJob(job: UploadJob): Promise<void> {
    await this.delivery.applyUploadJob(job);
    if (job.historyId) this.onChanged?.(job.historyId);
  }

  async applyTerminalUploadJob(job: UploadJob): Promise<void> {
    await this.delivery.applyTerminalUploadJob(job);
    if (job.historyId) this.onChanged?.(job.historyId);
  }

  async localSaveSettled(
    historyId: string,
    stream: RecordingStream,
    downloadId: number | undefined,
    settled: DownloadSettledResult,
    error?: string,
    kind?: RecordingArtifactKind,
    retryable = false,
  ): Promise<void> {
    await this.localDelivery.localSaveSettled(
      historyId,
      stream,
      downloadId,
      settled,
      error,
      kind,
      retryable,
    );
    this.onChanged?.(historyId);
  }

  async recordArtifactLocation(
    historyId: string,
    fileId: string,
    location: ArtifactLocation,
  ): Promise<void> {
    await this.localDelivery.recordArtifactLocation(historyId, fileId, location);
    this.onChanged?.(historyId);
  }

  async setExternalDeliveryState(
    historyId: string,
    fileId: string,
    destinationId: string,
    status: 'pending' | 'failed',
    error?: string,
  ): Promise<void> {
    const changed = await this.localDelivery.setExternalDeliveryState(
      historyId, fileId, destinationId, status, error,
    );
    if (changed) this.onChanged?.(historyId);
  }

  async replaceExternalPrimaryDestination(
    historyId: string,
    fromDestinationId: string,
    toDestinationId: string,
  ): Promise<boolean> {
    const changed = await this.localDelivery.replaceExternalPrimaryDestination(
      historyId, fromDestinationId, toDestinationId,
    );
    if (changed) this.onChanged?.(historyId);
    return changed;
  }

  async dropArtifactLocation(
    historyId: string,
    fileId: string,
    key: string,
  ): Promise<void> {
    await this.localDelivery.dropArtifactLocation(historyId, fileId, key);
    this.onChanged?.(historyId);
  }

  /** Persists proof only after the recordings page reports native media playback. */
  async markExternalPlaybackVerified(
    historyId: string,
    fileId: string,
    destinationId: string,
    artifactId: string,
  ): Promise<boolean> {
    const verified = await this.localDelivery.markExternalPlaybackVerified(
      historyId, fileId, destinationId, artifactId, this.now(),
    );
    if (verified) this.onChanged?.(historyId);
    return verified;
  }

  async setDriveDestination(historyId: string, presetId: string | null): Promise<void> {
    await this.metadata.setDriveDestination(historyId, presetId);
  }

  async setLocalFolder(
    historyId: string,
    folderName: string | undefined,
  ): Promise<void> {
    await this.metadata.setLocalFolder(historyId, folderName);
  }

  async openLocalFile(recordingId: string, fileId: string): Promise<void> {
    await this.localDelivery.openLocalFile(recordingId, fileId);
  }

  async planVerifiedRetainedMediaRelease(historyId: string): Promise<RetainedMediaReleaseTarget[]> {
    return this.retainedMediaRelease.plan(historyId);
  }

  /** Atomically records release intent and removes the corresponding OPFS replicas from history. */
  async markVerifiedRetainedMediaReleased(
    historyId: string,
    expected: readonly RetainedMediaReleaseTarget[],
  ): Promise<{ entry?: RecordingHistoryEntry; released: RetainedMediaReleaseTarget[] }> {
    return this.retainedMediaRelease.markReleased(historyId, expected);
  }

  async deleteReleasedRetainedMedia(
    historyId: string,
    targets: readonly RetainedMediaReleaseTarget[],
  ): Promise<'deleted' | 'deferred' | 'pending'> {
    return this.retainedMediaRelease.deleteReleased(historyId, targets);
  }
}
