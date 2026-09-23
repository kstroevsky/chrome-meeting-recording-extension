import type { StorageMode, UploadJob } from '../../../shared/recording';
import { isArtifactKind } from '../../../shared/recordingTypes';
import {
  pendingArtifactFields,
  recordingHistoryFileId,
  recordingLabelFromFilename,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
} from '../../../shared/recordingHistory';

export type PendingRecordingFile = Pick<
  RecordingHistoryFile,
  'id' | 'stream' | 'kind' | 'filename' | 'bytes' | 'captureStartOffsetMs'
>;

export function summarizeHistoryFiles(
  files: RecordingHistoryFile[],
): RecordingHistoryEntry['status'] {
  if (files.some((file) => file.status === 'unavailable')) return 'partial';
  if (files.every((file) => file.status === 'available')) return 'complete';
  return 'saving';
}

export function createPendingHistoryEntry(
  historyId: string,
  files: PendingRecordingFile[],
  storageMode: StorageMode,
  createdAt: number,
): RecordingHistoryEntry {
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
    status: summarizeHistoryFiles(nextFiles),
    files: nextFiles,
  };
}

export function createHistoryEntryFromUploadJob(job: UploadJob): RecordingHistoryEntry {
  const historyId = job.historyId!;
  const files = job.files.map((file) => ({
    id: recordingHistoryFileId(historyId, file.stream, file.kind),
    stream: file.stream,
    ...(isArtifactKind(file.kind) ? { kind: file.kind } : {}),
    filename: file.filename,
    ...(file.startOffsetMs != null ? { captureStartOffsetMs: file.startOffsetMs } : {}),
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
      ? {
          delivery: {
            requested: 'drive' as const,
            status: 'failed' as const,
            ...(file.error ? { error: file.error } : {}),
          },
        }
      : {}),
    destination: file.status === 'uploaded'
      || file.status === 'retry-pending'
      || job.status === 'uploading'
      ? 'drive' as const
      : 'local' as const,
    status: file.status === 'uploaded'
      ? 'available' as const
      : file.status === 'unavailable'
        ? 'unavailable' as const
        : 'pending' as const,
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
    status: summarizeHistoryFiles(files),
    files,
    ...(job.driveFolderId ? { driveFolderId: job.driveFolderId } : {}),
    ...(job.driveFolderName ? { driveFolderName: job.driveFolderName } : {}),
    ...(job.folderWebViewLink ? { folderWebViewLink: job.folderWebViewLink } : {}),
  };
}
