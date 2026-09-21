import type { StorageMode, UploadJob } from '../../../shared/recording';
import { isArtifactKind } from '../../../shared/recordingTypes';
import {
  pendingArtifactFields,
  recordingHistoryFileId,
  upsertArtifactLocation,
} from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';
import {
  createHistoryEntryFromUploadJob,
  createPendingHistoryEntry,
  summarizeHistoryFiles,
  type PendingRecordingFile,
} from './RecordingHistoryState';

export class RecordingDelivery {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly now: () => number,
  ) {}

  async createPending(
    historyId: string,
    files: PendingRecordingFile[],
    storageMode: StorageMode,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (current?.deletedAt) return current;
      if (!current) {
        return createPendingHistoryEntry(historyId, files, storageMode, this.now());
      }
      const known = new Set(current.files.map((file) => file.id));
      const additions = files
        .filter((file) => !known.has(file.id))
        .map((file) => ({
          ...file,
          ...pendingArtifactFields(file.filename, storageMode),
          destination: storageMode,
          status: 'pending' as const,
        }));
      if (!additions.length) return current;
      const nextFiles = [...current.files, ...additions];
      return {
        ...current,
        files: nextFiles,
        status: summarizeHistoryFiles(nextFiles),
      };
    });
  }

  async applyUploadJob(job: UploadJob): Promise<void> {
    if (!job.historyId) return;
    const historyId = job.historyId;
    await this.repository.update(historyId, (current) => {
      if (current?.deletedAt) return current;
      if (!current) return createHistoryEntryFromUploadJob(job);

      const files = current.files.map((file) => {
        const update = job.files.find((candidate) =>
          candidate.stream === file.stream
          && (candidate.kind ?? null) === (file.kind ?? null));
        if (!update) return file;

        if (update.status === 'uploaded') {
          return {
            ...file,
            destination: 'drive' as const,
            status: 'available' as const,
            driveFileId: update.driveFileId,
            webViewLink: update.webViewLink,
            error: undefined,
            locations: update.driveFileId
              ? upsertArtifactLocation(file.locations, {
                  kind: 'drive',
                  fileId: update.driveFileId,
                  ...(update.webViewLink ? { webViewLink: update.webViewLink } : {}),
                })
              : file.locations,
            delivery: {
              requested: file.delivery.requested,
              status: 'uploaded' as const,
            },
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
            delivery: {
              requested: file.delivery.requested,
              status: 'failed' as const,
              error: unavailable,
            },
          };
        }

        if (job.status === 'uploading') return file;
        if (file.destination === 'local' && file.status === 'available') return file;
        return {
          ...file,
          destination: 'local' as const,
          status: 'pending' as const,
          delivery: { ...file.delivery, status: 'pending' as const },
        };
      });

      const extra = job.files
        .filter((candidate) => isArtifactKind(candidate.kind)
          && !files.some((file) => file.kind === candidate.kind))
        .map((candidate) => ({
          id: recordingHistoryFileId(historyId, candidate.stream, candidate.kind),
          stream: candidate.stream,
          kind: candidate.kind!,
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
          destination: candidate.status === 'uploaded'
            ? 'drive' as const
            : 'local' as const,
          status: candidate.status === 'uploaded'
            ? 'available' as const
            : 'pending' as const,
          bytes: candidate.bytes,
          driveFileId: candidate.driveFileId,
          webViewLink: candidate.webViewLink,
        }));

      const nextFiles = [...files, ...extra];
      return {
        ...current,
        storageMode: 'drive',
        files: nextFiles,
        status: summarizeHistoryFiles(nextFiles),
        ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
        ...(job.driveFolderName ? { driveFolderName: job.driveFolderName } : {}),
        ...(job.folderWebViewLink ? { folderWebViewLink: job.folderWebViewLink } : {}),
      };
    });
  }

  async applyTerminalUploadJob(job: UploadJob): Promise<void> {
    if (job.status !== 'uploading') await this.applyUploadJob(job);
  }
}
