/**
 * @file shared/recordingConstants.ts
 *
 * Canonical recording defaults and allowed value sets used by normalization
 * helpers.
 */

import type { MicMode, RecordingPhase, RecordingRunConfig, StorageMode } from './recordingTypes';

export const DEFAULT_RECORDING_RUN_CONFIG: Readonly<RecordingRunConfig> = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

export const RECORDING_SESSION_STORAGE_KEY = 'recordingSession';

export const BUSY_RECORDING_PHASES = ['starting', 'recording', 'stopping', 'uploading'] as const satisfies readonly RecordingPhase[];
export const NON_IDLE_RECORDING_PHASES = ['starting', 'recording', 'stopping', 'uploading', 'failed'] as const satisfies readonly RecordingPhase[];
export const VALID_STORAGE_MODES = ['local', 'drive'] as const satisfies readonly StorageMode[];
export const VALID_MIC_MODES = ['off', 'mixed', 'separate'] as const satisfies readonly MicMode[];
