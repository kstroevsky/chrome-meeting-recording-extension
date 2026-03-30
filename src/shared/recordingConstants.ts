/**
 * @file shared/recordingConstants.ts
 *
 * Canonical recording defaults and allowed value sets used by normalization
 * helpers.
 */

import type {
  MicMode,
  RecordingPhase,
  RecordingRunConfig,
  StorageMode,
} from './recordingTypes';

type RecordingModeDefault = 'opfs' | 'drive';

const CONFIGURABLE_RUN_DEFAULTS = Object.freeze({
  // `opfs` maps to internal `local` storage mode.
  recordingMode: 'drive' as RecordingModeDefault,
  microphoneRecordingMode: 'separate' as MicMode,
  separateCameraCapture: true,
});

const DEFAULT_STORAGE_MODE: StorageMode =
  CONFIGURABLE_RUN_DEFAULTS.recordingMode === 'opfs' ? 'local' : 'drive';

// Single control point for extension default behavior.
export const EXTENSION_DEFAULTS = Object.freeze({
  configurable: CONFIGURABLE_RUN_DEFAULTS,
  runConfig: Object.freeze({
    storageMode: DEFAULT_STORAGE_MODE,
    micMode: CONFIGURABLE_RUN_DEFAULTS.microphoneRecordingMode,
    recordSelfVideo: CONFIGURABLE_RUN_DEFAULTS.separateCameraCapture,
  }) satisfies Readonly<RecordingRunConfig>,
  capture: Object.freeze({
    tab: Object.freeze({
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
    }),
    selfVideo: Object.freeze({
      width: 1920,
      height: 1080,
      frameRate: 30,
      aspectRatio: 16 / 9,
      defaultBitsPerSecond: 3_000_000,
      minAdaptiveBitsPerSecond: 1_000_000,
    }),
    microphone: Object.freeze({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
  }),
  chunking: Object.freeze({
    defaultTimesliceMs: 2000,
    extendedTimesliceMs: 4000,
  }),
});

export const DEFAULT_RECORDING_RUN_CONFIG: Readonly<RecordingRunConfig> = EXTENSION_DEFAULTS.runConfig;

export const RECORDING_SESSION_STORAGE_KEY = 'recordingSession';

export const BUSY_RECORDING_PHASES = ['starting', 'recording', 'stopping', 'uploading'] as const satisfies readonly RecordingPhase[];
export const NON_IDLE_RECORDING_PHASES = ['starting', 'recording', 'stopping', 'uploading', 'failed'] as const satisfies readonly RecordingPhase[];
export const VALID_STORAGE_MODES = ['local', 'drive'] as const satisfies readonly StorageMode[];
export const VALID_MIC_MODES = ['off', 'mixed', 'separate'] as const satisfies readonly MicMode[];
