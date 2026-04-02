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
} from './recordingConstants';
import type {
  MicMode,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStream,
  StorageMode,
  UploadSummary,
  UploadSummaryEntry,
} from './recordingTypes';
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
  const runConfig = phase === 'idle' ? null : parseRunConfig(candidate.runConfig);

  return {
    phase,
    runConfig,
    uploadSummary: normalizeUploadSummary(candidate.uploadSummary),
    error: typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error : undefined,
    warnings: normalizeWarnings(candidate.warnings),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

/** Returns true when the phase should disable popup controls and keep background alive. */
export function isBusyPhase(phase: RecordingPhase): boolean {
  return (BUSY_RECORDING_PHASES as readonly RecordingPhase[]).includes(phase);
}
