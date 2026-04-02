/**
 * @file shared/recording.ts
 *
 * Barrel re-export for the recording domain. Import from this file to access
 * types, constants, normalizers, and factory helpers together.
 *
 * Implementations live in focused sub-modules:
 *   recordingTypes.ts       — domain type definitions
 *   recordingConstants.ts   — default values and allowed-value arrays
 *   recordingNormalizers.ts — normalize* / parse* helpers
 *   recordingFactories.ts   — create* / get* factory helpers
 */

export type {
  MicMode,
  RecordingPhase,
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStream,
  StorageMode,
  UploadSummary,
  UploadSummaryEntry,
} from './recordingTypes';

export {
  BUSY_RECORDING_PHASES,
  DEFAULT_RECORDING_RUN_CONFIG,
  EXTENSION_DEFAULTS,
  NON_IDLE_RECORDING_PHASES,
  RECORDING_SESSION_STORAGE_KEY,
  VALID_MIC_MODES,
  VALID_STORAGE_MODES,
} from './recordingConstants';

export {
  createIdleSession,
  isBusyPhase,
  normalizeMicMode,
  normalizePhase,
  normalizeSessionSnapshot,
  normalizeStorageMode,
  normalizeUploadSummary,
  normalizeWarnings,
  parseRunConfig,
} from './recordingNormalizers';

export {
  createDefaultRunConfig,
  getRunConfigOrDefault,
} from './recordingFactories';
