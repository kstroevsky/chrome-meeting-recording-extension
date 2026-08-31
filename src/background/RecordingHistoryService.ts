import type { DownloadSettledResult } from '../platform/chrome/downloads';
import type { RecordingStream, StorageMode, UploadJob } from '../shared/recording';
import { buildRenamedRecordingFilename, slugifyRecordingTitle } from '../shared/recording';
import {
  recordingLabelFromFilename,
  type RecordingHistoryCursor,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
  type RecordingHistoryPage,
} from '../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

type PendingFile = Pick<RecordingHistoryFile, 'id' | 'stream' | 'filename' | 'bytes'>;
type DriveRenameResource = { id: string; name: string };
export type DriveRenameResult = {
  ok: boolean;
  resources?: DriveRenameResource[];
  error?: string;
  rollbackIncomplete?: boolean;
};
export type DriveRecordingRenamer = (resources: DriveRenameResource[]) => Promise<DriveRenameResult>;

/** Owns every recording-history transition, including delayed upload and download work. */
export class RecordingHistoryService {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly openDownload: (downloadId: number) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly renameDriveResources?: DriveRecordingRenamer,
    /**
     * Runs after an entry is tombstoned, so data owned by other aggregates
     * (notations, ADR-0005) is dropped with the recording. A callback rather
     * than a direct dependency keeps this service port-only.
     */
    private readonly onRemoved?: (id: string) => Promise<void>,
  ) {}

  async listPage(cursor?: RecordingHistoryCursor): Promise<RecordingHistoryPage> {
    return await this.repository.listPage({ cursor });
  }

  async list(): Promise<RecordingHistoryEntry[]> {
    return (await this.listPage()).entries;
  }

  async rename(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Recording name cannot be blank');
    const slug = slugifyRecordingTitle(trimmed);
    if (!slug) throw new Error('Recording name must contain at least one letter or number');
    const current = await this.repository.get(id);
    if (!current || current.deletedAt) return undefined;

    const remoteTargets = this.buildDriveRenameTargets(current, trimmed, slug);
    const renamedFileIds = new Set(remoteTargets?.slice(0, -1).map((target) => target.id) ?? []);
    if (remoteTargets) {
      if (!this.renameDriveResources) throw new Error('Drive rename is unavailable');
      const result = await this.renameDriveResources(remoteTargets);
      if (!result.ok) {
        if (result.rollbackIncomplete && result.resources?.length) {
          await this.syncObservedDriveNames(id, result.resources);
        }
        throw new Error(result.error || 'Could not rename the recording in Google Drive');
      }
    }

    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      const files = remoteTargets
        ? current.files.map((file) => file.driveFileId && renamedFileIds.has(file.driveFileId)
          ? { ...file, filename: buildRenamedRecordingFilename(trimmed, file.stream, file.filename) }
          : file)
        : current.files;
      return {
        ...current,
        name: trimmed,
        userNamed: true as const,
        files,
        ...(remoteTargets ? { driveFolderName: slug } : {}),
      };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  private buildDriveRenameTargets(entry: RecordingHistoryEntry, title: string, slug: string): DriveRenameResource[] | null {
    if (entry.storageMode !== 'drive') return null;
    // Legacy history rows predate folder IDs. Keep their established display-only
    // rename behavior because there is no reliable remote folder to target.
    if (!entry.driveFolderId) return null;
    const remoteFiles = entry.files.filter((file) => file.destination === 'drive' && file.status === 'available');
    if (remoteFiles.some((file) => !file.driveFileId)) {
      throw new Error('This Drive recording is missing the metadata needed to rename all uploaded files');
    }
    return [
      ...remoteFiles.map((file) => ({
        id: file.driveFileId!,
        name: buildRenamedRecordingFilename(title, file.stream, file.filename),
      })),
      { id: entry.driveFolderId, name: slug },
    ];
  }

  private async syncObservedDriveNames(id: string, resources: DriveRenameResource[]): Promise<void> {
    const byId = new Map(resources.map((resource) => [resource.id, resource.name]));
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return {
        ...current,
        files: current.files.map((file) => file.driveFileId && byId.has(file.driveFileId)
          ? { ...file, filename: byId.get(file.driveFileId)! }
          : file),
        ...(current.driveFolderId && byId.has(current.driveFolderId)
          ? { driveFolderName: byId.get(current.driveFolderId)! }
          : {}),
      };
    });
  }

  /**
   * Stores the run's recorded duration (pause-aware, excludes paused spans).
   * Written once by the finalize path after the row exists; a no-op for a
   * missing or deleted row so a late call can never resurrect one.
   */
  async setDuration(id: string, durationMs: number | undefined): Promise<RecordingHistoryEntry | undefined> {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return { ...current, durationMs };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  async setNote(id: string, note: string): Promise<RecordingHistoryEntry | undefined> {
    const normalized = note.trim();
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return normalized ? { ...current, note: normalized } : { ...current, note: undefined };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      removed = true;
      return { ...current, deletedAt: this.now() };
    });
    // The tombstone is the durable outcome; dependent cleanup is best-effort so
    // a failing side store can never make a delete look like it did not happen.
    if (removed && this.onRemoved) await this.onRemoved(id).catch(() => {});
    return removed;
  }

  async createPending(historyId: string, files: PendingFile[], storageMode: StorageMode): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (current?.deletedAt) return current;
      if (!current) return createEntry(historyId, files, storageMode, this.now());
      const known = new Set(current.files.map((file) => file.id));
      const additions = files.filter((file) => !known.has(file.id))
        .map((file) => ({ ...file, destination: storageMode, status: 'pending' as const }));
      return additions.length ? { ...current, files: [...current.files, ...additions], status: summarize([...current.files, ...additions]) } : current;
    });
  }

  /** Persists the initial and every later state of a detached Drive upload job. */
  async applyUploadJob(job: UploadJob): Promise<void> {
    if (!job.historyId) return;
    const historyId = job.historyId;
    await this.repository.update(historyId, (current) => {
      if (current?.deletedAt) return current;
      if (!current) return createEntryFromUploadJob(job);
      const files = current.files.map((file) => {
        const update = job.files.find((candidate) => candidate.stream === file.stream);
        if (!update) return file;
        if (update.status === 'uploaded') {
          return {
            ...file,
            destination: 'drive' as const,
            status: 'available' as const,
            driveFileId: update.driveFileId,
            webViewLink: update.webViewLink,
            error: undefined,
          };
        }
        if (update.status === 'retry-pending') {
          return {
            ...file,
            destination: 'drive' as const,
            status: 'pending' as const,
            error: update.error,
          };
        }
        if (update.status === 'unavailable') {
          return {
            ...file,
            destination: 'local' as const,
            status: 'unavailable' as const,
            error: update.error ?? 'Recovery source is no longer available',
          };
        }
        if (job.status === 'uploading') return file;
        // A retry that suppresses the duplicate local download must preserve a
        // previously confirmed local copy. First-attempt fallbacks wait for the
        // local-save lifecycle to settle their download id and availability.
        if (file.destination === 'local' && file.status === 'available') return file;
        return { ...file, destination: 'local' as const, status: 'pending' as const };
      });
      return {
        ...current,
        storageMode: 'drive',
        files,
        status: summarize(files),
        ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
        ...(job.driveFolderName ? { driveFolderName: job.driveFolderName } : {}),
        ...(job.folderWebViewLink ? { folderWebViewLink: job.folderWebViewLink } : {}),
      };
    });
  }

  async applyTerminalUploadJob(job: UploadJob): Promise<void> {
    if (job.status !== 'uploading') await this.applyUploadJob(job);
  }

  async localSaveSettled(
    historyId: string,
    stream: RecordingStream,
    downloadId: number | undefined,
    settled: DownloadSettledResult,
    error?: string,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const status: RecordingHistoryFile['status'] = settled === 'complete' ? 'available' : 'unavailable';
      const files = current.files.map((file) => file.stream === stream
        ? {
            ...file,
            destination: 'local' as const,
            status,
            downloadId,
            error: error ?? (status === 'unavailable' ? `Download ${settled}` : undefined),
          }
        : file);
      return { ...current, files, status: summarize(files) };
    });
  }

  async openLocalFile(recordingId: string, fileId: string): Promise<void> {
    const entry = await this.repository.get(recordingId);
    const file = entry && !entry.deletedAt ? entry.files.find((candidate) => candidate.id === fileId) : undefined;
    if (!file?.downloadId) throw new Error('This local file is no longer available');
    await this.openDownload(file.downloadId);
  }
}

function createEntry(historyId: string, files: PendingFile[], storageMode: StorageMode, createdAt: number): RecordingHistoryEntry {
  const nextFiles = files.map((file) => ({ ...file, destination: storageMode, status: 'pending' as const }));
  return {
    id: historyId,
    name: recordingLabelFromFilename(files[0]?.filename ?? 'Recording'),
    createdAt,
    storageMode,
    status: summarize(nextFiles),
    files: nextFiles,
  };
}

function createEntryFromUploadJob(job: UploadJob): RecordingHistoryEntry {
  const historyId = job.historyId!;
  const files = job.files.map((file) => ({
    id: `${historyId}:${file.stream}`,
    stream: file.stream,
    filename: file.filename,
    destination: file.status === 'uploaded' || file.status === 'retry-pending' || job.status === 'uploading' ? 'drive' as const : 'local' as const,
    status: file.status === 'uploaded' ? 'available' as const : file.status === 'unavailable' ? 'unavailable' as const : 'pending' as const,
    bytes: file.bytes,
    driveFileId: file.driveFileId,
    webViewLink: file.webViewLink,
    error: file.error,
  }));
  return {
    id: historyId,
    name: job.label,
    createdAt: job.startedAt,
    storageMode: 'drive',
    status: summarize(files),
    files,
    ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
    ...(job.driveFolderName ? { driveFolderName: job.driveFolderName } : {}),
    ...(job.folderWebViewLink ? { folderWebViewLink: job.folderWebViewLink } : {}),
  };
}

function summarize(files: RecordingHistoryFile[]): RecordingHistoryEntry['status'] {
  if (files.some((file) => file.status === 'unavailable')) return 'partial';
  if (files.every((file) => file.status === 'available')) return 'complete';
  return 'saving';
}
