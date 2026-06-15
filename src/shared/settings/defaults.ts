/**
 * @file shared/settings/defaults.ts
 *
 * Storage key, option lists, and immutable defaults for extension configuration.
 * Internal to the Settings module — only DEFAULT_EXTENSION_SETTINGS is re-exported
 * publicly through the module index.
 */

import { EXTENSION_DEFAULTS } from '../recordingConstants';
import type { MicMode } from '../recordingTypes';
import type {
  ExtensionSettings,
  LegacyVideoFormat,
  RecordingModeDefault,
  ResolutionDimensions,
  ResolutionPreset,
} from './model';

export const EXTENSION_SETTINGS_STORAGE_KEY = 'extensionSettings';
export const RECORDING_MODE_OPTIONS = ['opfs', 'drive'] as const;
export const MICROPHONE_MODE_OPTIONS = ['off', 'mixed', 'separate'] as const;
export const RESOLUTION_PRESET_OPTIONS = [
  '640x360',
  '854x480',
  '1280x720',
  '1920x1080',
] as const;

export const LEGACY_VIDEO_FORMAT_OPTIONS = [
  1080, 720, 480, 360,
] as const satisfies readonly LegacyVideoFormat[];
export const DEFAULT_RESOLUTION_PRESET: ResolutionPreset = '1920x1080';
export const MAX_SELF_VIDEO_BITRATE = EXTENSION_DEFAULTS.capture.selfVideo.defaultBitsPerSecond;

// Tab video bitrate scaling. `tabVideoBitrate` is the bitrate at the 1080p30
// reference; the recorder scales it linearly by the selected pixels-per-second
// (resolution × frame rate) and clamps the result to a sane floor/ceiling.
export const TAB_VIDEO_BITRATE_REFERENCE_PIXELS_PER_SECOND = 1920 * 1080 * 30;
export const TAB_MIN_VIDEO_BITRATE = 250_000;
export const MAX_TAB_VIDEO_BITRATE = 8_000_000;

export const RESOLUTION_PRESET_DIMENSIONS = Object.freeze({
  '640x360': Object.freeze({ width: 640, height: 360 }),
  '854x480': Object.freeze({ width: 854, height: 480 }),
  '1280x720': Object.freeze({ width: 1280, height: 720 }),
  '1920x1080': Object.freeze({ width: 1920, height: 1080 }),
}) satisfies Record<ResolutionPreset, Readonly<ResolutionDimensions>>;

export const LEGACY_CAMERA_FORMAT_TO_PRESET = Object.freeze({
  1080: '1920x1080',
  720: '1280x720',
  480: '854x480',
  360: '640x360',
}) satisfies Record<LegacyVideoFormat, ResolutionPreset>;

export const defaultRecordingMode: RecordingModeDefault =
  EXTENSION_DEFAULTS.configurable.recordingMode;
export const defaultMicMode: MicMode =
  EXTENSION_DEFAULTS.configurable.microphoneRecordingMode;

export const DEFAULT_EXTENSION_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  basic: Object.freeze({
    recordingMode: defaultRecordingMode,
    microphoneRecordingMode: defaultMicMode,
    separateCameraCapture: EXTENSION_DEFAULTS.configurable.separateCameraCapture,
    selfVideoResolutionPreset: DEFAULT_RESOLUTION_PRESET,
    selfVideoUseAutoResolution: false,
  }),
  professional: Object.freeze({
    selfVideoBitrate: EXTENSION_DEFAULTS.capture.selfVideo.defaultBitsPerSecond,
    selfVideoFrameRate: EXTENSION_DEFAULTS.capture.selfVideo.frameRate,
    selfVideoMinAdaptiveBitrate: EXTENSION_DEFAULTS.capture.selfVideo.minAdaptiveBitsPerSecond,
    tabResolutionPreset: DEFAULT_RESOLUTION_PRESET,
    tabMaxFrameRate: EXTENSION_DEFAULTS.capture.tab.maxFrameRate,
    tabVideoBitrate: EXTENSION_DEFAULTS.capture.tab.defaultBitsPerSecond,
    microphoneEchoCancellation: EXTENSION_DEFAULTS.capture.microphone.echoCancellation,
    microphoneNoiseSuppression: EXTENSION_DEFAULTS.capture.microphone.noiseSuppression,
    microphoneAutoGainControl: EXTENSION_DEFAULTS.capture.microphone.autoGainControl,
    chunkDefaultTimesliceMs: EXTENSION_DEFAULTS.chunking.defaultTimesliceMs,
    chunkExtendedTimesliceMs: EXTENSION_DEFAULTS.chunking.extendedTimesliceMs,
  }),
});
