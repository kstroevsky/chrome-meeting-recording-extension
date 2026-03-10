/**
 * @file shared/recording.ts
 *
 * Shared recording domain model: phases, run configuration, upload summaries,
 * persisted session snapshots, and normalization helpers.
 */

import {
  BUSY_RECORDING_PHASES,
  DEFAULT_RECORDING_RUN_CONFIG,
  NON_IDLE_RECORDING_PHASES,
  RECORDING_SESSION_STORAGE_KEY,
  VALID_MIC_MODES,
  VALID_SELF_VIDEO_RESOLUTION_MODES,
  VALID_STORAGE_MODES,
} from './recordingConstants';
import type {
  MicMode,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  SelfVideoResolutionMode,
  StorageMode,
  UploadSummary,
  UploadSummaryEntry,
} from './recordingTypes';
import { isRecord } from './typeGuards';

export type {
  MicMode,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStream,
  SelfVideoResolutionMode,
  StorageMode,
  UploadSummary,
  UploadSummaryEntry,
} from './recordingTypes';
export { DEFAULT_RECORDING_RUN_CONFIG, EXTENSION_DEFAULTS, RECORDING_SESSION_STORAGE_KEY } from './recordingConstants';

/** Returns true when a string exactly matches one of the allowed recording option values. */
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

/** Normalizes persisted self-video resolution mode values to the supported runtime modes. */
export function normalizeSelfVideoResolutionMode(value: unknown): SelfVideoResolutionMode {
  return hasAllowedString(value, VALID_SELF_VIDEO_RESOLUTION_MODES)
    ? value
    : DEFAULT_RECORDING_RUN_CONFIG.selfVideoResolutionMode;
}

/** Returns a detached clone of the default run configuration. */
export function createDefaultRunConfig(): RecordingRunConfig {
  return { ...DEFAULT_RECORDING_RUN_CONFIG };
}

/** Normalizes any run-config-like object into the strict runtime shape. */
export function normalizeRunConfig(value: unknown): RecordingRunConfig | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<RecordingRunConfig>;

  return {
    storageMode: normalizeStorageMode(candidate.storageMode),
    micMode: normalizeMicMode(candidate.micMode),
    recordSelfVideo:
      typeof candidate.recordSelfVideo === 'boolean'
        ? candidate.recordSelfVideo
        : DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo,
    selfVideoResolutionMode: normalizeSelfVideoResolutionMode(candidate.selfVideoResolutionMode),
  };
}

/** Returns a normalized run config or a cloned default when the input is invalid. */
export function getRunConfigOrDefault(value: unknown): RecordingRunConfig {
  return normalizeRunConfig(value) ?? createDefaultRunConfig();
}

/** Normalizes one upload summary entry and drops malformed or empty rows. */
function normalizeUploadSummaryEntry(entry: unknown): UploadSummaryEntry | null {
  if (!isRecord(entry)) return null;
  const candidate = entry as Partial<UploadSummaryEntry>;

  const stream =
    candidate.stream === 'mic' || candidate.stream === 'selfVideo' ? candidate.stream : 'tab';
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
      .map((entry) => normalizeUploadSummaryEntry(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  return {
    uploaded: normalizeEntries(candidate.uploaded),
    localFallbacks: normalizeEntries(candidate.localFallbacks),
  };
}

/** Creates the canonical idle session snapshot used as the safe fallback state. */
export function createIdleSession(now = Date.now()): RecordingSessionSnapshot {
  return {
    phase: 'idle',
    runConfig: null,
    updatedAt: now,
  };
}

/** Normalizes a persisted session snapshot while preserving only supported fields. */
export function normalizeSessionSnapshot(value: unknown): RecordingSessionSnapshot {
  if (!isRecord(value)) return createIdleSession();
  const candidate = value as Partial<RecordingSessionSnapshot>;
  const phase = normalizePhase(candidate.phase);
  const runConfig = phase === 'idle' ? null : normalizeRunConfig(candidate.runConfig);

  return {
    phase,
    runConfig,
    uploadSummary: normalizeUploadSummary(candidate.uploadSummary),
    error: typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error : undefined,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

/** Returns true when the phase should disable popup controls and keep background alive. */
export function isBusyPhase(phase: RecordingPhase): boolean {
  return (BUSY_RECORDING_PHASES as readonly RecordingPhase[]).includes(phase);
}
