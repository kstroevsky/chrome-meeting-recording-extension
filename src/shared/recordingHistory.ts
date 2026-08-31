import type { RecordingStream, StorageMode } from './recording';

export type RecordingHistoryFile = {
  id: string;
  stream: RecordingStream;
  /** Absent for media; `notes` marks the WebVTT sidecar (ADR-0005). */
  kind?: 'notes';
  filename: string;
  destination: StorageMode;
  status: 'pending' | 'available' | 'unavailable';
  bytes?: number;
  downloadId?: number;
  driveFileId?: string;
  webViewLink?: string;
  error?: string;
};

export type RecordingHistoryEntry = {
  id: string;
  name: string;
  /** Optional user-authored context for a recording. */
  note?: string;
  /** Captured duration when the recorder runtime supplied it. Legacy rows omit it. */
  durationMs?: number;
  userNamed?: true;
  /** Persisted per-recording Drive folder metadata for later artifact renames. */
  driveFolderId?: string;
  driveFolderName?: string;
  folderWebViewLink?: string;
  createdAt: number;
  storageMode: StorageMode;
  status: 'saving' | 'complete' | 'partial';
  files: RecordingHistoryFile[];
  /** Soft deletion prevents delayed upload/recovery work from resurrecting history. */
  deletedAt?: number;
};

export type RecordingHistoryCursor = { createdAt: number; id: string };

export type RecordingHistoryPage = {
  entries: RecordingHistoryEntry[];
  nextCursor?: RecordingHistoryCursor;
};

export type RecordingHistoryMessage =
  | { type: 'LIST_RECORDING_HISTORY'; cursor?: RecordingHistoryCursor }
  | { type: 'RENAME_RECORDING_HISTORY'; id: string; name: string }
  | { type: 'SET_RECORDING_HISTORY_NOTE'; id: string; note: string }
  | { type: 'REMOVE_RECORDING_HISTORY'; id: string }
  | { type: 'OPEN_RECORDING_HISTORY_FILE'; recordingId: string; fileId: string };

export function createRecordingHistoryId(): string {
  return `recording:${crypto.randomUUID()}`;
}

export function recordingLabelFromFilename(filename: string): string {
  return filename.replace(/-(recording|mic|self-video)\.(?:webm|mp4|m4a)$/, '') || filename;
}

/** Decodes durable history data before it reaches callers. Invalid rows are skipped. */
export function normalizeRecordingHistoryEntry(value: unknown): RecordingHistoryEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : undefined;
  const storageMode = candidate.storageMode === 'drive' ? 'drive' : candidate.storageMode === 'local' ? 'local' : undefined;
  if (!id || !name || createdAt == null || !storageMode || !Array.isArray(candidate.files)) return undefined;

  const files = candidate.files
    .map(normalizeRecordingHistoryFile)
    .filter((file): file is RecordingHistoryFile => file != null);
  if (!files.length) return undefined;

  const status = candidate.status === 'complete' || candidate.status === 'partial' || candidate.status === 'saving'
    ? candidate.status
    : summarizeHistoryFiles(files);
  const deletedAt = typeof candidate.deletedAt === 'number' && Number.isFinite(candidate.deletedAt)
    ? candidate.deletedAt
    : undefined;
  const note = typeof candidate.note === 'string' && candidate.note.trim()
    ? candidate.note.trim()
    : undefined;
  const durationMs = typeof candidate.durationMs === 'number' && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
    ? candidate.durationMs
    : undefined;
  return {
    id,
    name,
    ...(note ? { note } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(candidate.userNamed === true ? { userNamed: true as const } : {}),
    ...(typeof candidate.driveFolderId === 'string' && candidate.driveFolderId.trim() ? { driveFolderId: candidate.driveFolderId.trim() } : {}),
    ...(typeof candidate.driveFolderName === 'string' && candidate.driveFolderName.trim() ? { driveFolderName: candidate.driveFolderName.trim() } : {}),
    ...(typeof candidate.folderWebViewLink === 'string' && candidate.folderWebViewLink.trim() ? { folderWebViewLink: candidate.folderWebViewLink.trim() } : {}),
    createdAt,
    storageMode,
    status,
    files,
    ...(deletedAt != null ? { deletedAt } : {}),
  };
}

function normalizeRecordingHistoryFile(value: unknown): RecordingHistoryFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const filename = typeof candidate.filename === 'string' ? candidate.filename.trim() : '';
  const stream = candidate.stream === 'mic' || candidate.stream === 'self-video' ? candidate.stream : candidate.stream === 'tab' ? 'tab' : undefined;
  const destination = candidate.destination === 'drive' ? 'drive' : candidate.destination === 'local' ? 'local' : undefined;
  const status = candidate.status === 'available' || candidate.status === 'unavailable' || candidate.status === 'pending'
    ? candidate.status
    : undefined;
  if (!id || !filename || !stream || !destination || !status) return undefined;
  const optionalString = (field: string) => typeof candidate[field] === 'string' && candidate[field].trim()
    ? candidate[field].trim()
    : undefined;
  const bytes = typeof candidate.bytes === 'number' && candidate.bytes >= 0 ? candidate.bytes : undefined;
  const downloadId = typeof candidate.downloadId === 'number' && Number.isInteger(candidate.downloadId)
    ? candidate.downloadId
    : undefined;
  return {
    id,
    stream,
    ...(candidate.kind === 'notes' ? { kind: 'notes' as const } : {}),
    filename,
    destination,
    status,
    ...(bytes != null ? { bytes } : {}),
    ...(downloadId != null ? { downloadId } : {}),
    ...(optionalString('driveFileId') ? { driveFileId: optionalString('driveFileId') } : {}),
    ...(optionalString('webViewLink') ? { webViewLink: optionalString('webViewLink') } : {}),
    ...(optionalString('error') ? { error: optionalString('error') } : {}),
  };
}

function summarizeHistoryFiles(files: RecordingHistoryFile[]): RecordingHistoryEntry['status'] {
  if (files.some((file) => file.status === 'unavailable')) return 'partial';
  if (files.every((file) => file.status === 'available')) return 'complete';
  return 'saving';
}

export function isRecordingHistoryMessage(value: unknown): value is RecordingHistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'LIST_RECORDING_HISTORY') {
    const cursor = message.cursor;
    if (cursor == null) return true;
    if (typeof cursor !== 'object') return false;
    const candidate = cursor as Record<string, unknown>;
    return typeof candidate.createdAt === 'number'
      && Number.isFinite(candidate.createdAt)
      && typeof candidate.id === 'string'
      && candidate.id.length > 0;
  }
  if (message.type === 'RENAME_RECORDING_HISTORY') {
    return typeof message.id === 'string' && message.id.length > 0 && typeof message.name === 'string';
  }
  if (message.type === 'SET_RECORDING_HISTORY_NOTE') {
    return typeof message.id === 'string' && message.id.length > 0 && typeof message.note === 'string';
  }
  if (message.type === 'REMOVE_RECORDING_HISTORY') {
    return typeof message.id === 'string' && message.id.length > 0;
  }
  return message.type === 'OPEN_RECORDING_HISTORY_FILE'
    && typeof message.recordingId === 'string' && message.recordingId.length > 0
    && typeof message.fileId === 'string' && message.fileId.length > 0;
}
