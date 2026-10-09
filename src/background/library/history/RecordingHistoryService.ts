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
import { verifiedRetainedMediaReleaseTargets } from '../../../shared/recordingHistory';
import { LocalDeliveryHistory } from './LocalDeliveryHistory';
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
  private readonly localDelivery: LocalDeliveryHistory;
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
    ) => Promise<void | 'deleted' | 'deferred'>,
    private readonly warnCleanup: (message: string, error: unknown) => void = () => {},
    private readonly onChanged?: (recordingId: string) => void,
  ) {
    this.delivery = new RecordingDelivery(repository, now);
    this.localDelivery = new LocalDeliveryHistory(repository);
    this.renameCommands = new RecordingRename(repository, renameDriveResources);
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
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
      return undefined;
    }
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return { ...current, durationMs };
    });
    if (updated && !updated.deletedAt) this.onChanged?.(id);
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
    if (updated && !updated.deletedAt) this.onChanged?.(id);
    return updated?.deletedAt ? undefined : updated;
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      removed = true;
      return { ...current, deletedAt: this.now(), cleanupPending: true };
    });

    if (removed) await this.cleanupDeletedEntry(id).catch(() => {});
    return removed;
  }

  async retryPendingCleanup(): Promise<boolean> {
    const pending = await this.repository.listCleanupPending();
    let allSucceeded = true;
    for (const entry of pending) {
      try {
        await this.cleanupDeletedEntry(entry.id, entry);
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

  async planVerifiedRetainedMediaRelease(historyId: string): Promise<RetainedMediaReleaseTarget[]> {
    const entry = await this.get(historyId);
    return entry ? verifiedRetainedMediaReleaseTargets(entry) : [];
  }

  /** Atomically records release intent and removes the corresponding OPFS replicas from history. */
  async markVerifiedRetainedMediaReleased(
    historyId: string,
    expected: readonly RetainedMediaReleaseTarget[],
  ): Promise<{ entry?: RecordingHistoryEntry; released: RetainedMediaReleaseTarget[] }> {
    const expectedKeys = new Set(expected.map((target) => `${target.fileId}\u0000${target.key}`));
    const released: RetainedMediaReleaseTarget[] = [];
    const updated = await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => {
        if (file.kind || !file.locations.some((location) =>
          location.kind === 'external' && location.playbackVerifiedAt != null)) return file;
        const releasedKeys = file.locations
          .filter((location): location is Extract<ArtifactLocation, { kind: 'opfs' }> =>
            location.kind === 'opfs' && expectedKeys.has(`${file.id}\u0000${location.key}`));
        if (!releasedKeys.length) return file;
        const releasedAt = this.now();
        const markerByKey = new Map((file.releasedRetainedMedia ?? []).map((marker) => [marker.key, marker]));
        for (const location of releasedKeys) {
          markerByKey.set(location.key, { key: location.key, releasedAt });
          released.push({ fileId: file.id, key: location.key, ...(file.bytes != null ? { bytes: file.bytes } : {}) });
        }
        return {
          ...file,
          locations: file.locations.filter((location) =>
            location.kind !== 'opfs' || !releasedKeys.some((releasedLocation) => releasedLocation.key === location.key)),
          releasedRetainedMedia: [...markerByKey.values()],
        };
      });
      return released.length ? { ...current, files } : current;
    });
    if (released.length) this.onChanged?.(historyId);
    return { ...(updated && !updated.deletedAt ? { entry: updated } : {}), released };
  }

  async deleteReleasedRetainedMedia(
    historyId: string,
    targets: readonly RetainedMediaReleaseTarget[],
  ): Promise<'deleted' | 'deferred' | 'pending'> {
    if (!targets.length) return 'deleted';
    if (!this.deleteRetainedMedia) return 'pending';
    try {
      const disposition = await this.deleteRetainedMedia(targets.map((target) => target.key), historyId);
      return disposition === 'deferred' ? 'deferred' : 'deleted';
    } catch (error) {
      this.warnCleanup(`Could not free retained media for recording ${historyId}:`, error);
      return 'pending';
    }
  }

  private async cleanupDeletedEntry(
    id: string,
    knownEntry?: RecordingHistoryEntry,
  ): Promise<void> {
    const entry = knownEntry ?? await this.repository.get(id);
    if (!entry?.deletedAt || !entry.cleanupPending) return;
    const retainedKeys = entry.files.flatMap((file) => file.locations
      .filter((location) => location.kind === 'opfs')
      .map((location) => location.key));
    const work: Array<{ label: string; run: () => Promise<void> }> = [];
    if (this.onRemoved) work.push({ label: 'dependent data', run: () => this.onRemoved!(id) });
    if (retainedKeys.length && this.deleteRetainedMedia) {
      work.push({
        label: 'retained media',
        run: async () => { await this.deleteRetainedMedia!(retainedKeys, id); },
      });
    }

    const results = await Promise.allSettled(work.map(({ run }) => run()));
    const failures = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [];
      const label = work[index]?.label ?? 'cleanup';
      this.warnCleanup(`Could not clean up recording ${id} ${label}:`, result.reason);
      return [result.reason];
    });
    if (failures.length) throw failures[0];

    await this.repository.update(id, (current) => {
      if (!current?.deletedAt || !current.cleanupPending) return current;
      const { cleanupPending: _completed, ...rest } = current;
      return rest;
    });
  }
}
