import type { DownloadSettledResult } from '../platform/chrome/downloads';
import type { RecordingStream, StorageMode, UploadJob } from '../shared/recording';
import { buildRenamedRecordingFilename, slugifyRecordingTitle } from '../shared/recording';
import {
  pendingArtifactFields,
  recordingHistoryFileId,
  recordingLabelFromFilename,
  upsertArtifactLocation,
  type ArtifactDelivery,
  type ArtifactLocation,
  type RecordingHistoryCursor,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
  type RecordingHistoryPage,
} from '../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

type PendingFile = Pick<RecordingHistoryFile, 'id' | 'stream' | 'kind' | 'filename' | 'bytes'>;
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
    /**
     * Deletes extension-owned playback copies when a recording is removed
     * (ADR-0006). Only OPFS keys are ever passed here: a user's Downloads file
     * and their Drive file are theirs, and removing a history row must not
     * touch either.
     */
    private readonly deleteRetainedMedia?: (keys: string[], historyId: string) => Promise<void>,
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
          ? { ...file, filename: buildRenamedRecordingFilename(trimmed, file.stream, file.filename, file.kind) }
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
    // A Drive id claimed by two rows cannot be renamed: each row would name it
    // differently and the last write would win. Renaming the wrong file is how
    // a notes sidecar ended up called `-mic.webm`, so an ambiguous id is left
    // alone rather than guessed at.
    const claims = new Map<string, number>();
    for (const file of remoteFiles) claims.set(file.driveFileId!, (claims.get(file.driveFileId!) ?? 0) + 1);
    const unambiguous = remoteFiles.filter((file) => claims.get(file.driveFileId!) === 1);
    return [
      ...unambiguous.map((file) => ({
        id: file.driveFileId!,
        name: buildRenamedRecordingFilename(title, file.stream, file.filename, file.kind),
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
    let retainedKeys: string[] = [];
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      removed = true;
      retainedKeys = current.files.flatMap((file) => file.locations
        .filter((location) => location.kind === 'opfs')
        .map((location) => location.key));
      return { ...current, deletedAt: this.now() };
    });
    // The tombstone is the durable outcome; dependent cleanup is best-effort so
    // a failing side store can never make a delete look like it did not happen.
    if (removed && this.onRemoved) await this.onRemoved(id).catch(() => {});
    // Internal playback copies go with the recording. A file still being played
    // is handled by the playback lease (ADR-0006 §15), which defers this;
    // until leases exist, the startup reconciler collects anything missed.
    if (removed && retainedKeys.length && this.deleteRetainedMedia) {
      await this.deleteRetainedMedia(retainedKeys, id).catch(() => {});
    }
    return removed;
  }

  async createPending(historyId: string, files: PendingFile[], storageMode: StorageMode): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (current?.deletedAt) return current;
      if (!current) return createEntry(historyId, files, storageMode, this.now());
      const known = new Set(current.files.map((file) => file.id));
      const additions = files.filter((file) => !known.has(file.id))
        .map((file) => ({
          ...file,
          ...pendingArtifactFields(file.filename, storageMode),
          destination: storageMode,
          status: 'pending' as const,
        }));
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
        // Matched on stream *and* kind: the notes sidecar rides a media stream,
        // so matching on stream alone handed the media row the sidecar's Drive
        // id — and the rename then renamed the sidecar as if it were the media.
        const update = job.files.find((candidate) =>
          candidate.stream === file.stream && (candidate.kind ?? null) === (file.kind ?? null));
        if (!update) return file;
        if (update.status === 'uploaded') {
          return {
            ...file,
            destination: 'drive' as const,
            status: 'available' as const,
            driveFileId: update.driveFileId,
            webViewLink: update.webViewLink,
            error: undefined,
            // The Drive copy is a replica added alongside whatever already
            // exists, not a reassignment of the file's one destination.
            locations: update.driveFileId
              ? upsertArtifactLocation(file.locations, {
                  kind: 'drive',
                  fileId: update.driveFileId,
                  ...(update.webViewLink ? { webViewLink: update.webViewLink } : {}),
                })
              : file.locations,
            delivery: { requested: file.delivery.requested, status: 'uploaded' as const },
          };
        }
        if (update.status === 'retry-pending') {
          return {
            ...file,
            destination: 'drive' as const,
            status: 'pending' as const,
            error: update.error,
            delivery: {
              requested: file.delivery.requested,
              status: 'pending' as const,
              ...(update.error ? { error: update.error } : {}),
            },
          };
        }
        if (update.status === 'unavailable') {
          const unavailable = update.error ?? 'Recovery source is no longer available';
          return {
            ...file,
            destination: 'local' as const,
            status: 'unavailable' as const,
            error: unavailable,
            delivery: { requested: file.delivery.requested, status: 'failed' as const, error: unavailable },
          };
        }
        if (job.status === 'uploading') return file;
        // A retry that suppresses the duplicate local download must preserve a
        // previously confirmed local copy. First-attempt fallbacks wait for the
        // local-save lifecycle to settle their download id and availability.
        if (file.destination === 'local' && file.status === 'available') return file;
        // Drive failed; the local-save lifecycle decides whether this settles as
        // `local-fallback` or `failed`, so delivery stays pending until then.
        return {
          ...file,
          destination: 'local' as const,
          status: 'pending' as const,
          delivery: { ...file.delivery, status: 'pending' as const },
        };
      });
      // A job file with no row yet — the sidecar, which is created during the
      // run rather than at finalize — becomes its own row instead of vanishing.
      const extra = job.files
        .filter((candidate) => candidate.kind === 'notes'
          && !files.some((file) => file.kind === 'notes'))
        .map((candidate) => ({
          id: recordingHistoryFileId(historyId, candidate.stream, 'notes'),
          stream: candidate.stream,
          kind: 'notes' as const,
          filename: candidate.filename,
          ...pendingArtifactFields(candidate.filename, 'drive'),
          ...(candidate.status === 'uploaded' && candidate.driveFileId
            ? {
                locations: [{
                  kind: 'drive' as const,
                  fileId: candidate.driveFileId,
                  ...(candidate.webViewLink ? { webViewLink: candidate.webViewLink } : {}),
                }],
                delivery: { requested: 'drive' as const, status: 'uploaded' as const },
              }
            : {}),
          destination: candidate.status === 'uploaded' ? 'drive' as const : 'local' as const,
          status: candidate.status === 'uploaded' ? 'available' as const : 'pending' as const,
          bytes: candidate.bytes,
          driveFileId: candidate.driveFileId,
          webViewLink: candidate.webViewLink,
        }));

      return {
        ...current,
        storageMode: 'drive',
        files: [...files, ...extra],
        status: summarize([...files, ...extra]),
        ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
        ...(job.driveFolderName ? { driveFolderName: job.driveFolderName } : {}),
        ...(job.folderWebViewLink ? { folderWebViewLink: job.folderWebViewLink } : {}),
      };
    });
  }

  async applyTerminalUploadJob(job: UploadJob): Promise<void> {
    if (job.status !== 'uploading') await this.applyUploadJob(job);
  }

  /**
   * Settles one locally delivered artifact. `kind` is required to identify it:
   * the notes sidecar rides a media stream (ADR-0005), so matching on `stream`
   * alone hands the sidecar the media file's download — the same trap
   * `applyUploadJob` already avoids by matching on stream *and* kind.
   */
  async localSaveSettled(
    historyId: string,
    stream: RecordingStream,
    downloadId: number | undefined,
    settled: DownloadSettledResult,
    error?: string,
    kind?: 'notes',
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const status: RecordingHistoryFile['status'] = settled === 'complete' ? 'available' : 'unavailable';
      const files = current.files.map((file) => {
        if (file.stream !== stream || (file.kind ?? null) !== (kind ?? null)) return file;
        const failure = error ?? (status === 'unavailable' ? `Download ${settled}` : undefined);
        // A Downloads copy is a replica. Whether it is the delivery the user
        // asked for, or the fallback after Drive failed, is what `requested`
        // decides — which is why `local-fallback` is not derivable from here alone.
        const delivery: ArtifactDelivery = settled === 'complete'
          ? {
              requested: file.delivery.requested,
              status: file.delivery.requested === 'drive' ? 'local-fallback' : 'downloaded',
            }
          : { requested: file.delivery.requested, status: 'failed', ...(failure ? { error: failure } : {}) };
        return {
          ...file,
          destination: 'local' as const,
          status,
          downloadId,
          error: failure,
          locations: settled === 'complete' && downloadId != null
            ? upsertArtifactLocation(file.locations, { kind: 'download', downloadId })
            : file.locations,
          delivery,
        };
      });
      return { ...current, files, status: summarize(files) };
    });
  }

  /**
   * Records one physical replica of an artifact (ADR-0006). Used by the
   * finalize path to persist a retained OPFS copy before external delivery is
   * even attempted, so a failed download still leaves a playable recording.
   * A no-op for a missing or tombstoned row, so a late call cannot resurrect one.
   */
  async recordArtifactLocation(
    historyId: string,
    fileId: string,
    location: ArtifactLocation,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => file.id === fileId
        ? { ...file, locations: upsertArtifactLocation(file.locations, location) }
        : file);
      return { ...current, files };
    });
  }

  /**
   * Removes one replica claim. Used when a retained file turns out to be gone:
   * the claim is dropped, never the row, because another replica (Drive, or a
   * Downloads copy) may still make the recording reachable.
   */
  async dropArtifactLocation(historyId: string, fileId: string, key: string): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => file.id === fileId
        ? { ...file, locations: file.locations.filter((location) => !(location.kind === 'opfs' && location.key === key)) }
        : file);
      return { ...current, files };
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
  const nextFiles = files.map((file) => ({
    ...file,
    ...pendingArtifactFields(file.filename, storageMode),
    destination: storageMode,
    status: 'pending' as const,
  }));
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
    // The sidecar rides a media stream so the upload can order it, so it cannot
    // be keyed by that stream: it would collide with the real file of the same
    // stream, and its own `kind` has to survive for the rename to name it.
    id: recordingHistoryFileId(historyId, file.stream, file.kind),
    stream: file.stream,
    ...(file.kind === 'notes' ? { kind: 'notes' as const } : {}),
    filename: file.filename,
    ...pendingArtifactFields(file.filename, 'drive'),
    ...(file.status === 'uploaded' && file.driveFileId
      ? {
          locations: [{
            kind: 'drive' as const,
            fileId: file.driveFileId,
            ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
          }],
          delivery: { requested: 'drive' as const, status: 'uploaded' as const },
        }
      : {}),
    ...(file.status === 'unavailable'
      ? { delivery: { requested: 'drive' as const, status: 'failed' as const, ...(file.error ? { error: file.error } : {}) } }
      : {}),
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
