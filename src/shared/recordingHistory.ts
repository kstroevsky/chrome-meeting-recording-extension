import type { RecordingStream, StorageMode } from './recording';
import { contentTypeForRecordingFilename } from './recordingFormats';

/**
 * Where a logical artifact physically exists. A recording artifact is immutable
 * logical media; OPFS, Downloads and Drive are *replicas* of it (ADR-0006), so
 * one file can hold several at once — a Drive upload that fell back locally has
 * both. At most one replica per `kind`.
 */
export type ArtifactLocation =
  | { kind: 'opfs'; key: string; retainedAt: number }
  | { kind: 'download'; downloadId: number }
  | { kind: 'drive'; fileId: string; webViewLink?: string };

export type ArtifactDeliveryStatus = 'pending' | 'downloaded' | 'uploaded' | 'local-fallback' | 'failed';

/** Did the delivery the user asked for succeed? Not the same as where bytes are. */
export type ArtifactDelivery = {
  /** What the user requested at recording time. `StorageMode` is 'local' | 'drive'. */
  requested: StorageMode;
  status: ArtifactDeliveryStatus;
  error?: string;
};

export type RecordingHistoryFile = {
  id: string;
  stream: RecordingStream;
  /** Absent for media; `notes` marks the WebVTT sidecar (ADR-0005). */
  kind?: 'notes';
  filename: string;
  /** Container type of the stored bytes; derived from the filename on legacy rows. */
  mimeType: string;
  /**
   * Signed offset of this track's first sample relative to the tab/master track.
   * Independently started MediaRecorders land close together, but "close" is not
   * a durable media-format invariant (ADR-0006). Negative is meaningful: this
   * track started *before* the master.
   */
  timelineOffsetMs?: number;
  /** Every physical replica of these bytes. Empty means the extension owns none. */
  locations: ArtifactLocation[];
  delivery: ArtifactDelivery;

  // Legacy single-destination fields, retained for one migration period
  // (ADR-0006). `locations` and `delivery` are the truth for new code.
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

/**
 * Stable identity of one artifact inside a recording. The notes sidecar rides a
 * media stream (ADR-0005), so it cannot be keyed by stream alone — it would
 * collide with that stream's media row. Derived in one place because three call
 * sites deriving it independently is how they drifted apart.
 */
export function recordingHistoryFileId(historyId: string, stream: RecordingStream, kind?: 'notes'): string {
  return kind === 'notes' ? `${historyId}:notes` : `${historyId}:${stream}`;
}

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

  const files = dedupeById(candidate.files
    .map((file) => normalizeRecordingHistoryFile(file, storageMode))
    .filter((file): file is RecordingHistoryFile => file != null));
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

function normalizeRecordingHistoryFile(value: unknown, requested: StorageMode): RecordingHistoryFile | undefined {
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
  const driveFileId = optionalString('driveFileId');
  const webViewLink = optionalString('webViewLink');
  const error = optionalString('error');
  const legacy: LegacyDeliveryFields = { destination, status, downloadId, driveFileId, webViewLink, error };
  // A row written before ADR-0006 carries no `locations`, so its replicas are
  // synthesized from the single-destination fields. A row that *has* the field
  // keeps it verbatim — including a deliberately empty list — so re-normalizing
  // can never resurrect a replica its owner just removed.
  const locations = Array.isArray(candidate.locations)
    ? candidate.locations.map(normalizeArtifactLocation).filter((location): location is ArtifactLocation => location != null)
    : locationsFromLegacyFields(legacy);
  // Signed: a negative offset is valid data, so this cannot reuse the `>= 0`
  // guard the byte counts use.
  const timelineOffsetMs = typeof candidate.timelineOffsetMs === 'number' && Number.isFinite(candidate.timelineOffsetMs)
    ? candidate.timelineOffsetMs
    : undefined;
  return {
    id,
    stream,
    ...(candidate.kind === 'notes' ? { kind: 'notes' as const } : {}),
    filename,
    mimeType: optionalString('mimeType') ?? contentTypeForRecordingFilename(filename),
    ...(timelineOffsetMs != null ? { timelineOffsetMs } : {}),
    locations,
    delivery: normalizeArtifactDelivery(candidate.delivery, legacy, requested),
    destination,
    status,
    ...(bytes != null ? { bytes } : {}),
    ...(downloadId != null ? { downloadId } : {}),
    ...(driveFileId ? { driveFileId } : {}),
    ...(webViewLink ? { webViewLink } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeArtifactLocation(value: unknown): ArtifactLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'opfs') {
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
    const retainedAt = typeof candidate.retainedAt === 'number' && Number.isFinite(candidate.retainedAt)
      ? candidate.retainedAt
      : undefined;
    return key && retainedAt != null ? { kind: 'opfs', key, retainedAt } : undefined;
  }
  if (candidate.kind === 'download') {
    return typeof candidate.downloadId === 'number' && Number.isInteger(candidate.downloadId)
      ? { kind: 'download', downloadId: candidate.downloadId }
      : undefined;
  }
  if (candidate.kind === 'drive') {
    const fileId = typeof candidate.fileId === 'string' ? candidate.fileId.trim() : '';
    const webViewLink = typeof candidate.webViewLink === 'string' && candidate.webViewLink.trim()
      ? candidate.webViewLink.trim()
      : undefined;
    return fileId ? { kind: 'drive', fileId, ...(webViewLink ? { webViewLink } : {}) } : undefined;
  }
  return undefined;
}

const ARTIFACT_DELIVERY_STATUSES: readonly ArtifactDeliveryStatus[] = [
  'pending',
  'downloaded',
  'uploaded',
  'local-fallback',
  'failed',
];

function normalizeArtifactDelivery(value: unknown, legacy: LegacyDeliveryFields, requested: StorageMode): ArtifactDelivery {
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const stored = ARTIFACT_DELIVERY_STATUSES.find((entry) => entry === candidate.status);
    if (stored) {
      const storedRequested = candidate.requested === 'drive' ? 'drive'
        : candidate.requested === 'local' ? 'local'
        : requested;
      const error = typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error.trim() : undefined;
      return { requested: storedRequested, status: stored, ...(error ? { error } : {}) };
    }
  }
  return deliveryFromLegacyFields(legacy, requested);
}

type LegacyDeliveryFields = {
  destination: StorageMode;
  status: RecordingHistoryFile['status'];
  downloadId?: number;
  driveFileId?: string;
  webViewLink?: string;
  error?: string;
};

/** Replicas implied by a pre-ADR-0006 row's single-destination fields. */
export function locationsFromLegacyFields(
  file: Pick<LegacyDeliveryFields, 'downloadId' | 'driveFileId' | 'webViewLink'>,
): ArtifactLocation[] {
  const locations: ArtifactLocation[] = [];
  if (file.downloadId != null) locations.push({ kind: 'download', downloadId: file.downloadId });
  if (file.driveFileId) {
    locations.push({ kind: 'drive', fileId: file.driveFileId, ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}) });
  }
  return locations;
}

/**
 * Delivery outcome implied by a pre-ADR-0006 row. `local-fallback` is precisely
 * the case the legacy shape could not express: Drive was requested, the bytes
 * landed in Downloads, and the row recorded only where they landed.
 */
export function deliveryFromLegacyFields(file: LegacyDeliveryFields, requested: StorageMode): ArtifactDelivery {
  const status: ArtifactDeliveryStatus = file.status === 'unavailable' ? 'failed'
    : file.status === 'pending' ? 'pending'
    : file.destination === 'drive' ? 'uploaded'
    : requested === 'drive' ? 'local-fallback'
    : 'downloaded';
  return { requested, status, ...(file.error ? { error: file.error } : {}) };
}

/** Adds or replaces the replica of `next.kind`, leaving the other kinds in place. */
export function upsertArtifactLocation(locations: ArtifactLocation[], next: ArtifactLocation): ArtifactLocation[] {
  return [...locations.filter((location) => location.kind !== next.kind), next];
}

/** ADR-0006 fields for a freshly created row that has no replicas yet. */
export function pendingArtifactFields(
  filename: string,
  requested: StorageMode,
): Pick<RecordingHistoryFile, 'mimeType' | 'locations' | 'delivery'> {
  return {
    mimeType: contentTypeForRecordingFilename(filename),
    locations: [],
    delivery: { requested, status: 'pending' },
  };
}

/**
 * Two rows must never share an id. When durable data holds a pair anyway — a
 * notes sidecar that took a media row's identity wrote exactly this — keeping
 * both is the worst option: the player shows the file twice, and a rename picks
 * one at random and renames the other's Drive file to match.
 *
 * The id says what the row is supposed to be, so that is the tie-breaker: a
 * `:notes` id keeps the row marked `notes`, any other id keeps the row that is
 * not. A remaining tie keeps the larger file, because a stub beside real media
 * is the stub.
 */
function dedupeById(files: RecordingHistoryFile[]): RecordingHistoryFile[] {
  const byId = new Map<string, RecordingHistoryFile>();
  for (const file of files) {
    const existing = byId.get(file.id);
    if (!existing) { byId.set(file.id, file); continue; }
    byId.set(file.id, preferred(existing, file));
  }
  return [...byId.values()];
}

function preferred(a: RecordingHistoryFile, b: RecordingHistoryFile): RecordingHistoryFile {
  const wantsNotes = a.id.endsWith(':notes');
  const aMatches = (a.kind === 'notes') === wantsNotes;
  const bMatches = (b.kind === 'notes') === wantsNotes;
  if (aMatches !== bMatches) return aMatches ? a : b;
  return (b.bytes ?? 0) > (a.bytes ?? 0) ? b : a;
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
