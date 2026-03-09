/**
 * @file shared/extensionSettings.ts
 *
 * User-configurable extension settings with storage persistence and runtime
 * normalization helpers.
 */

import { getLocalStorageValues, hasLocalStorageArea, setLocalStorageValues } from '../platform/chrome/storage';
import { EXTENSION_DEFAULTS } from './recordingConstants';
import type { MicMode, RecordingRunConfig, StorageMode } from './recordingTypes';
import { isRecord } from './typeGuards';

export const EXTENSION_SETTINGS_STORAGE_KEY = 'extensionSettings';
export const VIDEO_FORMAT_OPTIONS = [1080, 720, 480, 360] as const;
export const RECORDING_MODE_OPTIONS = ['opfs', 'drive'] as const;
export const MICROPHONE_MODE_OPTIONS = ['off', 'mixed', 'separate'] as const;

export type VideoFormat = (typeof VIDEO_FORMAT_OPTIONS)[number];
export type RecordingModeDefault = (typeof RECORDING_MODE_OPTIONS)[number];

export type ExtensionSettings = {
  basic: {
    recordingMode: RecordingModeDefault;
    microphoneRecordingMode: MicMode;
    separateCameraCapture: boolean;
    selfVideoWidthFormat: VideoFormat;
    selfVideoHeightFormat: VideoFormat;
  };
  professional: {
    selfVideoBitrate: number;
    selfVideoFrameRate: number;
    selfVideoMinAdaptiveBitrate: number;
    tabMaxWidth: number;
    tabMaxHeight: number;
    tabMaxFrameRate: number;
    microphoneEchoCancellation: boolean;
    microphoneNoiseSuppression: boolean;
    microphoneAutoGainControl: boolean;
    chunkDefaultTimesliceMs: number;
    chunkExtendedTimesliceMs: number;
  };
};

export type SelfVideoProfileSettings = {
  width: number;
  height: number;
  frameRate: number;
  aspectRatio: number;
  defaultBitsPerSecond: number;
  minAdaptiveBitsPerSecond: number;
};

export type TabCaptureSettings = {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
};

export type MicrophoneCaptureSettings = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type ChunkingSettings = {
  defaultTimesliceMs: number;
  extendedTimesliceMs: number;
};

const WIDTH_BY_FORMAT: Record<VideoFormat, number> = {
  1080: 1920,
  720: 1280,
  480: 854,
  360: 640,
};

function hasAllowedString<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function normalizeVideoFormat(value: unknown, fallback: VideoFormat): VideoFormat {
  if (VIDEO_FORMAT_OPTIONS.includes(value as VideoFormat)) return value as VideoFormat;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (VIDEO_FORMAT_OPTIONS.includes(parsed as VideoFormat)) return parsed as VideoFormat;
  }
  return fallback;
}

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return {
    basic: { ...settings.basic },
    professional: { ...settings.professional },
  };
}

const defaultRecordingMode: RecordingModeDefault =
  EXTENSION_DEFAULTS.configurable.recordingMode;
const defaultMicMode: MicMode = EXTENSION_DEFAULTS.configurable.microphoneRecordingMode;

export const DEFAULT_EXTENSION_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  basic: Object.freeze({
    recordingMode: defaultRecordingMode,
    microphoneRecordingMode: defaultMicMode,
    separateCameraCapture: EXTENSION_DEFAULTS.configurable.separateCameraCapture,
    selfVideoWidthFormat: 1080,
    selfVideoHeightFormat: 1080,
  }),
  professional: Object.freeze({
    selfVideoBitrate: EXTENSION_DEFAULTS.capture.selfVideo.defaultBitsPerSecond,
    selfVideoFrameRate: EXTENSION_DEFAULTS.capture.selfVideo.frameRate,
    selfVideoMinAdaptiveBitrate: EXTENSION_DEFAULTS.capture.selfVideo.minAdaptiveBitsPerSecond,
    tabMaxWidth: EXTENSION_DEFAULTS.capture.tab.maxWidth,
    tabMaxHeight: EXTENSION_DEFAULTS.capture.tab.maxHeight,
    tabMaxFrameRate: EXTENSION_DEFAULTS.capture.tab.maxFrameRate,
    microphoneEchoCancellation: EXTENSION_DEFAULTS.capture.microphone.echoCancellation,
    microphoneNoiseSuppression: EXTENSION_DEFAULTS.capture.microphone.noiseSuppression,
    microphoneAutoGainControl: EXTENSION_DEFAULTS.capture.microphone.autoGainControl,
    chunkDefaultTimesliceMs: EXTENSION_DEFAULTS.chunking.defaultTimesliceMs,
    chunkExtendedTimesliceMs: EXTENSION_DEFAULTS.chunking.extendedTimesliceMs,
  }),
});

let runtimeSettings: ExtensionSettings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);

export function normalizeExtensionSettings(value: unknown): ExtensionSettings {
  if (!isRecord(value)) return cloneSettings(DEFAULT_EXTENSION_SETTINGS);
  const basicCandidate = isRecord(value.basic) ? value.basic : {};
  const professionalCandidate = isRecord(value.professional) ? value.professional : {};

  const basic: ExtensionSettings['basic'] = {
    recordingMode: hasAllowedString(basicCandidate.recordingMode, RECORDING_MODE_OPTIONS)
      ? basicCandidate.recordingMode
      : DEFAULT_EXTENSION_SETTINGS.basic.recordingMode,
    microphoneRecordingMode: hasAllowedString(basicCandidate.microphoneRecordingMode, MICROPHONE_MODE_OPTIONS)
      ? basicCandidate.microphoneRecordingMode
      : DEFAULT_EXTENSION_SETTINGS.basic.microphoneRecordingMode,
    separateCameraCapture:
      typeof basicCandidate.separateCameraCapture === 'boolean'
        ? basicCandidate.separateCameraCapture
        : DEFAULT_EXTENSION_SETTINGS.basic.separateCameraCapture,
    selfVideoWidthFormat: normalizeVideoFormat(
      basicCandidate.selfVideoWidthFormat,
      DEFAULT_EXTENSION_SETTINGS.basic.selfVideoWidthFormat
    ),
    selfVideoHeightFormat: normalizeVideoFormat(
      basicCandidate.selfVideoHeightFormat,
      DEFAULT_EXTENSION_SETTINGS.basic.selfVideoHeightFormat
    ),
  };

  const professional: ExtensionSettings['professional'] = {
    selfVideoBitrate: normalizePositiveInt(
      professionalCandidate.selfVideoBitrate,
      DEFAULT_EXTENSION_SETTINGS.professional.selfVideoBitrate,
      100_000,
      50_000_000
    ),
    selfVideoFrameRate: normalizePositiveInt(
      professionalCandidate.selfVideoFrameRate,
      DEFAULT_EXTENSION_SETTINGS.professional.selfVideoFrameRate,
      1,
      120
    ),
    selfVideoMinAdaptiveBitrate: normalizePositiveInt(
      professionalCandidate.selfVideoMinAdaptiveBitrate,
      DEFAULT_EXTENSION_SETTINGS.professional.selfVideoMinAdaptiveBitrate,
      100_000,
      50_000_000
    ),
    tabMaxWidth: normalizePositiveInt(
      professionalCandidate.tabMaxWidth,
      DEFAULT_EXTENSION_SETTINGS.professional.tabMaxWidth,
      320,
      7680
    ),
    tabMaxHeight: normalizePositiveInt(
      professionalCandidate.tabMaxHeight,
      DEFAULT_EXTENSION_SETTINGS.professional.tabMaxHeight,
      180,
      4320
    ),
    tabMaxFrameRate: normalizePositiveInt(
      professionalCandidate.tabMaxFrameRate,
      DEFAULT_EXTENSION_SETTINGS.professional.tabMaxFrameRate,
      1,
      120
    ),
    microphoneEchoCancellation:
      typeof professionalCandidate.microphoneEchoCancellation === 'boolean'
        ? professionalCandidate.microphoneEchoCancellation
        : DEFAULT_EXTENSION_SETTINGS.professional.microphoneEchoCancellation,
    microphoneNoiseSuppression:
      typeof professionalCandidate.microphoneNoiseSuppression === 'boolean'
        ? professionalCandidate.microphoneNoiseSuppression
        : DEFAULT_EXTENSION_SETTINGS.professional.microphoneNoiseSuppression,
    microphoneAutoGainControl:
      typeof professionalCandidate.microphoneAutoGainControl === 'boolean'
        ? professionalCandidate.microphoneAutoGainControl
        : DEFAULT_EXTENSION_SETTINGS.professional.microphoneAutoGainControl,
    chunkDefaultTimesliceMs: normalizePositiveInt(
      professionalCandidate.chunkDefaultTimesliceMs,
      DEFAULT_EXTENSION_SETTINGS.professional.chunkDefaultTimesliceMs,
      250,
      60_000
    ),
    chunkExtendedTimesliceMs: normalizePositiveInt(
      professionalCandidate.chunkExtendedTimesliceMs,
      DEFAULT_EXTENSION_SETTINGS.professional.chunkExtendedTimesliceMs,
      250,
      60_000
    ),
  };

  if (professional.chunkExtendedTimesliceMs < professional.chunkDefaultTimesliceMs) {
    professional.chunkExtendedTimesliceMs = professional.chunkDefaultTimesliceMs;
  }
  if (professional.selfVideoMinAdaptiveBitrate > professional.selfVideoBitrate) {
    professional.selfVideoMinAdaptiveBitrate = professional.selfVideoBitrate;
  }

  return { basic, professional };
}

export function getRuntimeExtensionSettings(): Readonly<ExtensionSettings> {
  return runtimeSettings;
}

export function getWidthByFormat(format: VideoFormat): number {
  return WIDTH_BY_FORMAT[format];
}

export function toStorageMode(recordingMode: RecordingModeDefault): StorageMode {
  return recordingMode === 'opfs' ? 'local' : 'drive';
}

export function buildDefaultRunConfigFromSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): RecordingRunConfig {
  return {
    storageMode: toStorageMode(settings.basic.recordingMode),
    micMode: settings.basic.microphoneRecordingMode,
    recordSelfVideo: settings.basic.separateCameraCapture,
  };
}

export function getSelfVideoProfileSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): SelfVideoProfileSettings {
  const width = getWidthByFormat(settings.basic.selfVideoWidthFormat);
  const height = settings.basic.selfVideoHeightFormat;
  return {
    width,
    height,
    frameRate: settings.professional.selfVideoFrameRate,
    aspectRatio: width / height,
    defaultBitsPerSecond: settings.professional.selfVideoBitrate,
    minAdaptiveBitsPerSecond: settings.professional.selfVideoMinAdaptiveBitrate,
  };
}

export function getTabCaptureSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): TabCaptureSettings {
  return {
    maxWidth: settings.professional.tabMaxWidth,
    maxHeight: settings.professional.tabMaxHeight,
    maxFrameRate: settings.professional.tabMaxFrameRate,
  };
}

export function getMicrophoneCaptureSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): MicrophoneCaptureSettings {
  return {
    echoCancellation: settings.professional.microphoneEchoCancellation,
    noiseSuppression: settings.professional.microphoneNoiseSuppression,
    autoGainControl: settings.professional.microphoneAutoGainControl,
  };
}

export function getChunkingSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): ChunkingSettings {
  return {
    defaultTimesliceMs: settings.professional.chunkDefaultTimesliceMs,
    extendedTimesliceMs: settings.professional.chunkExtendedTimesliceMs,
  };
}

export async function loadExtensionSettingsFromStorage(): Promise<ExtensionSettings> {
  if (!hasLocalStorageArea()) {
    runtimeSettings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
    return cloneSettings(runtimeSettings);
  }
  const stored = await getLocalStorageValues(EXTENSION_SETTINGS_STORAGE_KEY);
  runtimeSettings = normalizeExtensionSettings(stored[EXTENSION_SETTINGS_STORAGE_KEY]);
  return cloneSettings(runtimeSettings);
}

export async function saveExtensionSettingsToStorage(value: unknown): Promise<ExtensionSettings> {
  runtimeSettings = normalizeExtensionSettings(value);
  if (hasLocalStorageArea()) {
    await setLocalStorageValues({ [EXTENSION_SETTINGS_STORAGE_KEY]: runtimeSettings });
  }
  return cloneSettings(runtimeSettings);
}

export async function resetExtensionSettingsToDefaults(): Promise<ExtensionSettings> {
  return await saveExtensionSettingsToStorage(DEFAULT_EXTENSION_SETTINGS);
}
