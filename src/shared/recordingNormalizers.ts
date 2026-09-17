/**
 * @file shared/recordingNormalizers.ts
 *
 * Normalization and parsing helpers for recording domain values.
 *
 * Naming convention:
 *   normalize*(value): T   — always returns a usable value; falls back to a
 *                            safe default when the input is invalid. Never null.
 *   parse*(value): T|null  — returns a typed value when the input is valid,
 *                            or null/undefined when it cannot be interpreted.
 */

import {
  BUSY_RECORDING_PHASES,
  DEFAULT_RECORDING_RUN_CONFIG,
  NON_IDLE_RECORDING_PHASES,
  VALID_MIC_MODES,
  VALID_STORAGE_MODES,
  VALID_TAB_CONTENT_TYPES,
} from './recordingConstants';
import { MAX_RECORDED_SPANS } from './recordingTypes';
import type {
  CapturedTabResolution,
  RecordedSpan,
  RecordingCaptureDevices,
  DesiredState,
  MicMode,
  ObservedState,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStream,
  StorageMode,
  TabContentType,
  UploadJob,
  UploadJobFile,
  UploadJobStatus,
  UploadSummary,
  UploadSummaryEntry,
} from './recordingTypes';
import { projectPhase } from './recordingProjection';
import { isRecord } from './typeGuards';

/** Returns true when a string exactly matches one of the allowed values. */
function hasAllowedString<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

/** Normalizes an arbitrary phase-like value into the canonical recording phase union. */
export function normalizePhase(value: unknown): RecordingPhase {
  return hasAllowedString(value, NON_IDLE_RECORDING_PHASES) ? value : 'idle';
}

/** Normalizes persisted storage mode values to the supported runtime storage modes. */
export function normalizeStorageMode(value: unknown): StorageMode {
  return hasAllowedString(value, VALID_STORAGE_MODES) ? value : DEFAULT_RECORDING_RUN_CONFIG.storageMode;
}

/** Normalizes persisted microphone mode values to the supported microphone modes. */
export function normalizeMicMode(value: unknown): MicMode {
  return hasAllowedString(value, VALID_MIC_MODES) ? value : DEFAULT_RECORDING_RUN_CONFIG.micMode;
}

/** Normalizes the per-recording tab content preset to a supported value. */
export function normalizeTabContentType(value: unknown): TabContentType {
  return hasAllowedString(value, VALID_TAB_CONTENT_TYPES)
    ? value
    : DEFAULT_RECORDING_RUN_CONFIG.tabContentType ?? 'screen';
}

/**
 * Parses any run-config-like object into the strict runtime shape.
 * Returns null when the input is not a record (use getRunConfigOrDefault for a
 * fallback-safe variant).
 */
export function parseRunConfig(value: unknown): RecordingRunConfig | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<RecordingRunConfig>;

  return {
    storageMode: normalizeStorageMode(candidate.storageMode),
    micMode: normalizeMicMode(candidate.micMode),
    recordSelfVideo:
      typeof candidate.recordSelfVideo === 'boolean'
        ? candidate.recordSelfVideo
        : DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo,
    tabContentType: normalizeTabContentType(candidate.tabContentType),
  };
}

/** Normalizes one upload summary entry; returns null for malformed or empty rows. */
function parseUploadSummaryEntry(entry: unknown): UploadSummaryEntry | null {
  if (!isRecord(entry)) return null;
  const candidate = entry as Partial<UploadSummaryEntry>;

  // Accept the legacy 'selfVideo' value written by older extension versions.
  const rawStream = (candidate.stream as unknown) === 'selfVideo' ? 'self-video' : candidate.stream;
  const stream: RecordingStream =
    rawStream === 'mic' || rawStream === 'self-video' ? rawStream : 'tab';

  const filename = typeof candidate.filename === 'string' ? candidate.filename.trim() : '';
  if (!filename) return null;
  const error = typeof candidate.error === 'string' ? candidate.error.trim() : '';
  const bytes = typeof candidate.bytes === 'number' && candidate.bytes >= 0 ? candidate.bytes : undefined;
  const driveFileId = typeof candidate.driveFileId === 'string' && candidate.driveFileId.trim()
    ? candidate.driveFileId.trim()
    : undefined;
  const webViewLink = typeof candidate.webViewLink === 'string' && candidate.webViewLink.trim()
    ? candidate.webViewLink.trim()
    : undefined;

  return {
    stream,
    filename,
    bytes,
    driveFileId,
    webViewLink,
    error: error || undefined,
  };
}

/** Normalizes persisted upload summary data and filters unusable entries. */
export function normalizeUploadSummary(value: unknown): UploadSummary | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as Partial<UploadSummary>;

  const normalizeEntries = (entries: unknown): UploadSummaryEntry[] => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => parseUploadSummaryEntry(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  return {
    uploaded: normalizeEntries(candidate.uploaded),
    localFallbacks: normalizeEntries(candidate.localFallbacks),
    driveFolderId: typeof candidate.driveFolderId === 'string' && candidate.driveFolderId.trim()
      ? candidate.driveFolderId.trim()
      : undefined,
    driveFolderName: typeof candidate.driveFolderName === 'string' && candidate.driveFolderName.trim()
      ? candidate.driveFolderName.trim()
      : undefined,
    folderWebViewLink: typeof candidate.folderWebViewLink === 'string' && candidate.folderWebViewLink.trim()
      ? candidate.folderWebViewLink.trim()
      : undefined,
  };
}

const VALID_UPLOAD_JOB_STATUSES: readonly UploadJobStatus[] = ['uploading', 'completed', 'failed', 'partial', 'canceled'];
const VALID_NAMING_STATUSES = ['pending', 'named', 'skipped'] as const;
const VALID_UPLOAD_JOB_FILE_STATUSES: readonly UploadJobFile['status'][] = ['uploading', 'uploaded', 'fallback', 'retry-pending', 'unavailable'];
const VALID_RECORDING_STREAMS: readonly RecordingStream[] = ['tab', 'mic', 'self-video'];

function parseUploadJobFile(value: unknown): UploadJobFile | null {
  if (!isRecord(value)) return null;
  const stream = value.stream;
  const filename = value.filename;
  const status = value.status;
  if (!(VALID_RECORDING_STREAMS as readonly unknown[]).includes(stream)) return null;
  if (typeof filename !== 'string' || !filename) return null;
  if (!(VALID_UPLOAD_JOB_FILE_STATUSES as readonly unknown[]).includes(status)) return null;
  const bytes = typeof value.bytes === 'number' && value.bytes >= 0 ? value.bytes : undefined;
  const driveFileId = typeof value.driveFileId === 'string' && value.driveFileId.trim()
    ? value.driveFileId.trim()
    : undefined;
  const webViewLink = typeof value.webViewLink === 'string' && value.webViewLink.trim()
    ? value.webViewLink.trim()
    : undefined;
  const error = typeof value.error === 'string' && value.error.trim()
    ? value.error.trim()
    : undefined;
  return {
    stream: stream as RecordingStream,
    // Absent for media; `notes` marks the WebVTT sidecar (ADR-0005).
    ...(value.kind === 'notes' ? { kind: 'notes' as const } : {}),
    filename,
    status: status as UploadJobFile['status'],
    bytes,
    driveFileId,
    webViewLink,
    error,
  };
}

function parseUploadJob(value: unknown): UploadJob | null {
  if (!isRecord(value)) return null;
  const { id, label, status, progress, startedAt, finishedAt, files } = value;
  if (typeof id !== 'string' || !id) return null;
  if (!(VALID_UPLOAD_JOB_STATUSES as readonly unknown[]).includes(status)) return null;
  const normalizedFiles = Array.isArray(files)
    ? files.map(parseUploadJobFile).filter((f): f is UploadJobFile => f != null)
    : [];
  return {
    id,
    historyId: typeof value.historyId === 'string' && value.historyId ? value.historyId : undefined,
    label: typeof label === 'string' ? label : id,
    status: status as UploadJobStatus,
    progress: typeof progress === 'number' && progress >= 0 ? Math.min(1, progress) : 0,
    folderWebViewLink: typeof value.folderWebViewLink === 'string' && value.folderWebViewLink.trim()
      ? value.folderWebViewLink.trim()
      : undefined,
    driveFolderId: typeof value.driveFolderId === 'string' && value.driveFolderId.trim()
      ? value.driveFolderId.trim()
      : undefined,
    driveFolderName: typeof value.driveFolderName === 'string' && value.driveFolderName.trim()
      ? value.driveFolderName.trim()
      : undefined,
    namingStatus: (VALID_NAMING_STATUSES as readonly unknown[]).includes(value.namingStatus)
      ? value.namingStatus as UploadJob['namingStatus']
      : undefined,
    recoveryPending: value.recoveryPending === true ? true : undefined,
    files: normalizedFiles,
    startedAt: typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now(),
    finishedAt: typeof finishedAt === 'number' && finishedAt > 0 ? finishedAt : undefined,
  };
}

/**
 * Normalizes the persisted background upload-job list (ADR-0004). Phase-independent:
 * jobs outlive the recording session, so they are NOT cleared on idle. Returns
 * undefined for an empty/absent list to match the optional-field convention.
 */
export function normalizeUploadJobs(value: unknown): UploadJob[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const jobs = value.map(parseUploadJob).filter((j): j is UploadJob => j != null);
  return jobs.length ? jobs : undefined;
}

/** Normalizes session warnings into trimmed, unique strings. */
export function normalizeWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });

  return normalized.length ? normalized : undefined;
}

/** Normalizes an optional Chrome tab id stored with the active recording. */
function normalizeTargetTabId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Normalizes an optional Meet URL slug stored with the active recording. */
function normalizeMeetingSlug(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalizes the persisted run epoch (fencing token, see ADR-0003). Preserved
 * regardless of phase so it survives across `idle` and stays monotonic.
 */
function normalizeEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizeTabResolution(value: unknown): CapturedTabResolution | undefined {
  if (!isRecord(value)) return undefined;
  const width = normalizePositiveInt(value.width);
  const height = normalizePositiveInt(value.height);
  return width != null || height != null ? { width, height } : undefined;
}

const VALID_OBSERVED_STATES: readonly ObservedState[] = [
  'none',
  'starting',
  'recording',
  'stopping',
  'idle',
];

/** Parses a persisted command-plane intent; returns null when absent/invalid. */
function parseDesired(value: unknown): DesiredState | null {
  return value === 'idle' || value === 'recording' ? value : null;
}

/** Parses a persisted status-plane observation; returns null when absent/invalid. */
function parseObserved(value: unknown): ObservedState | null {
  return (VALID_OBSERVED_STATES as readonly unknown[]).includes(value) ? (value as ObservedState) : null;
}

/**
 * Reconstructs the (desired, observed, failed) planes from a legacy persisted
 * `phase` written before ADR-0003 Decision 4. This is the inverse of `projectPhase`
 * and must round-trip: `projectPhase(decomposeLegacyPhase(p)) === p` for every `p`
 * (asserted in tests/recordingProjection.test.ts).
 */
function decomposeLegacyPhase(phase: RecordingPhase): { desired: DesiredState; observed: ObservedState; failed: boolean } {
  switch (phase) {
    case 'idle':
      return { desired: 'idle', observed: 'idle', failed: false };
    case 'starting':
      return { desired: 'recording', observed: 'starting', failed: false };
    case 'recording':
      return { desired: 'recording', observed: 'recording', failed: false };
    case 'stopping':
      return { desired: 'idle', observed: 'stopping', failed: false };
    case 'failed':
      return { desired: 'idle', observed: 'none', failed: true };
  }
}

/** Keeps only non-empty input-device labels from a persisted active session. */
function normalizeCapturedDevices(value: unknown): RecordingCaptureDevices | undefined {
  if (!isRecord(value)) return undefined;
  const microphone = typeof value.microphone === 'string' && value.microphone.trim()
    ? value.microphone.trim()
    : undefined;
  const camera = typeof value.camera === 'string' && value.camera.trim()
    ? value.camera.trim()
    : undefined;
  return microphone || camera ? { microphone, camera } : undefined;
}

/** Creates the canonical idle session snapshot used as the safe fallback state. */
export function createIdleSession(now = Date.now()): RecordingSessionSnapshot {
  return {
    phase: 'idle',
    desired: 'idle',
    observed: 'idle',
    failed: false,
    runConfig: null,
    updatedAt: now,
  };
}

/** Normalizes a persisted session snapshot while preserving only supported fields. */
export function normalizeSessionSnapshot(value: unknown): RecordingSessionSnapshot {
  if (!isRecord(value)) return createIdleSession();
  const candidate = value as Partial<RecordingSessionSnapshot>;

  // Reconstruct the two ADR-0003 planes. Prefer authoritative values when the
  // snapshot was written by current code; otherwise rebuild them from the legacy
  // `phase` so a pre-Decision-4 persisted snapshot still rehydrates correctly.
  const desiredRaw = parseDesired(candidate.desired);
  const observedRaw = parseObserved(candidate.observed);
  const planes =
    desiredRaw != null && observedRaw != null
      ? { desired: desiredRaw, observed: observedRaw, failed: candidate.failed === true }
      : decomposeLegacyPhase(normalizePhase(candidate.phase));
  const { desired, observed, failed } = planes;
  const phase = projectPhase(desired, observed, failed);

  const runConfig = phase === 'idle' ? null : parseRunConfig(candidate.runConfig);
  const targetTabId = phase === 'idle' ? undefined : normalizeTargetTabId(candidate.targetTabId);
  const meetingSlug = phase === 'idle' ? undefined : normalizeMeetingSlug(candidate.meetingSlug);
  const historyId = phase === 'idle' || typeof candidate.historyId !== 'string' || !candidate.historyId
    ? undefined
    : candidate.historyId;

  return {
    phase,
    desired,
    observed,
    failed,
    runConfig,
    targetTabId,
    meetingSlug,
    historyId,
    // Phase-independent: the epoch is preserved across idle so it stays monotonic.
    epoch: normalizeEpoch(candidate.epoch),
    // Phase-independent (ADR-0007): the transcript sweep reads the span ledger
    // after the run has finished, so it must outlive the return to idle.
    recordedSpans: normalizeRecordedSpans(candidate.recordedSpans),
    // Phase-independent (design n4): an interruption outlives its run, because
    // the capture is already saved and the user still has to be told.
    interruption: normalizeInterruption(candidate.interruption),
    // Phase-independent (ADR-0004): background upload jobs outlive the recording
    // session, so they survive across idle and a new run.
    uploadJobs: normalizeUploadJobs(candidate.uploadJobs),
    uploadSummary: normalizeUploadSummary(candidate.uploadSummary),
    error: typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error : undefined,
    warnings: normalizeWarnings(candidate.warnings),
    micMuted: phase === 'idle' ? undefined : candidate.micMuted === true ? true : undefined,
    cameraMuted: phase === 'idle' ? undefined : candidate.cameraMuted === true ? true : undefined,
    paused: phase === 'idle' ? undefined : candidate.paused === true ? true : undefined,
    recordedMs:
      phase === 'idle'
        ? undefined
        : typeof candidate.recordedMs === 'number' && candidate.recordedMs >= 0
          ? candidate.recordedMs
          : 0,
    runningSince:
      phase === 'idle'
        ? undefined
        : typeof candidate.runningSince === 'number' && candidate.runningSince > 0
          ? candidate.runningSince
          : undefined,
    tabResolution: phase === 'idle' ? undefined : normalizeTabResolution(candidate.tabResolution),
    capturedDevices: phase === 'idle' ? undefined : normalizeCapturedDevices(candidate.capturedDevices),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

const VALID_INTERRUPTIONS: readonly string[] = ['tab-closed', 'navigated-away', 'meeting-ended'];

function normalizeInterruption(value: unknown): RecordingSessionSnapshot['interruption'] {
  if (!isRecord(value)) return undefined;
  const { reason, atMs, historyId } = value;
  if (typeof reason !== 'string' || !VALID_INTERRUPTIONS.includes(reason)) return undefined;
  if (typeof historyId !== 'string' || !historyId) return undefined;
  const position = typeof atMs === 'number' && Number.isFinite(atMs) && atMs >= 0 ? atMs : 0;
  return { reason: reason as NonNullable<RecordingSessionSnapshot['interruption']>['reason'], atMs: position, historyId };
}

/** Returns true when the phase should disable popup controls and keep background alive. */
export function isBusyPhase(phase: RecordingPhase): boolean {
  return (BUSY_RECORDING_PHASES as readonly RecordingPhase[]).includes(phase);
}

/**
 * True when any background upload job is still running (ADR-0004). The extension is
 * "busy" — and must defer update-reloads / offscreen teardown — when the recording
 * phase is busy OR this is true, so a decoupled upload is never torn down mid-flight.
 */
export function hasUploadsInFlight(jobs: UploadJob[] | undefined): boolean {
  return !!jobs?.some((job) => job.status === 'uploading');
}

/** True when a stop request can act on the phase (active capture in progress). */
export function isStoppablePhase(phase: RecordingPhase): boolean {
  return phase === 'starting' || phase === 'recording' || phase === 'stopping';
}

/**
 * Decodes the recorded-span ledger. A span with no usable start is dropped
 * rather than repaired: a wrong span would map words onto media positions they
 * were never spoken at, which is worse than having no transcript for them.
 */
function normalizeRecordedSpans(value: unknown): RecordedSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const spans: RecordedSpan[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const wallStartMs = finiteNonNegative(candidate.wallStartMs);
    const mediaStartMs = finiteNonNegative(candidate.mediaStartMs);
    if (wallStartMs == null || mediaStartMs == null) continue;

    const wallEndMs = finiteNonNegative(candidate.wallEndMs);
    spans.push({
      wallStartMs,
      mediaStartMs,
      ...(wallEndMs != null && wallEndMs >= wallStartMs ? { wallEndMs } : {}),
    });
    if (spans.length >= MAX_RECORDED_SPANS) break;
  }
  return spans.length ? spans : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
