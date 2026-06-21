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
import type {
  DesiredState,
  MicMode,
  ObservedState,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStream,
  StorageMode,
  TabContentType,
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

  return {
    stream,
    filename,
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
  };
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

const VALID_OBSERVED_STATES: readonly ObservedState[] = [
  'none',
  'starting',
  'recording',
  'stopping',
  'uploading',
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
    case 'uploading':
      return { desired: 'idle', observed: 'uploading', failed: false };
    case 'failed':
      return { desired: 'idle', observed: 'none', failed: true };
  }
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

  return {
    phase,
    desired,
    observed,
    failed,
    runConfig,
    targetTabId,
    meetingSlug,
    // Phase-independent: the epoch is preserved across idle so it stays monotonic.
    epoch: normalizeEpoch(candidate.epoch),
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
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

/** Returns true when the phase should disable popup controls and keep background alive. */
export function isBusyPhase(phase: RecordingPhase): boolean {
  return (BUSY_RECORDING_PHASES as readonly RecordingPhase[]).includes(phase);
}

/** True when a stop request can act on the phase (active capture in progress). */
export function isStoppablePhase(phase: RecordingPhase): boolean {
  return phase === 'starting' || phase === 'recording' || phase === 'stopping';
}
