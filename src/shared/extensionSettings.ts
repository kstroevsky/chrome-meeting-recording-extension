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
export const RECORDING_MODE_OPTIONS = ['opfs', 'drive'] as const;
export const MICROPHONE_MODE_OPTIONS = ['off', 'mixed', 'separate'] as const;
export const RESOLUTION_PRESET_OPTIONS = [
  '640x360',
  '854x480',
  '1280x720',
  '1920x1080',
] as const;

export type RecordingModeDefault = (typeof RECORDING_MODE_OPTIONS)[number];
export type ResolutionPreset = (typeof RESOLUTION_PRESET_OPTIONS)[number];

type LegacyVideoFormat = 1080 | 720 | 480 | 360;
type ResolutionDimensions = {
  width: number;
  height: number;
};

export type ExtensionSettings = {
  basic: {
    recordingMode: RecordingModeDefault;
    microphoneRecordingMode: MicMode;
    separateCameraCapture: boolean;
    selfVideoResolutionPreset: ResolutionPreset;
  };
  professional: {
    selfVideoBitrate: number;
    selfVideoFrameRate: number;
    selfVideoMinAdaptiveBitrate: number;
    tabResolutionPreset: ResolutionPreset;
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

const LEGACY_VIDEO_FORMAT_OPTIONS = [1080, 720, 480, 360] as const satisfies readonly LegacyVideoFormat[];
const DEFAULT_RESOLUTION_PRESET: ResolutionPreset = '1920x1080';
const MAX_SELF_VIDEO_BITRATE = EXTENSION_DEFAULTS.capture.selfVideo.defaultBitsPerSecond;

export const RESOLUTION_PRESET_DIMENSIONS = Object.freeze({
  '640x360': Object.freeze({ width: 640, height: 360 }),
  '854x480': Object.freeze({ width: 854, height: 480 }),
  '1280x720': Object.freeze({ width: 1280, height: 720 }),
  '1920x1080': Object.freeze({ width: 1920, height: 1080 }),
}) satisfies Record<ResolutionPreset, Readonly<ResolutionDimensions>>;

const LEGACY_CAMERA_FORMAT_TO_PRESET = Object.freeze({
  1080: '1920x1080',
  720: '1280x720',
  480: '854x480',
  360: '640x360',
}) satisfies Record<LegacyVideoFormat, ResolutionPreset>;

/** Returns true when a string exactly matches one of the allowed option values. */
function hasAllowedString<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

/** Normalizes a number-like input into a bounded positive integer or a fallback. */
function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** Parses a number-like value into a positive integer when possible. */
function readPositiveInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  return rounded > 0 ? rounded : null;
}

/** Normalizes a persisted preset key to one of the supported resolution presets. */
function normalizeResolutionPreset(value: unknown, fallback: ResolutionPreset): ResolutionPreset {
  if (hasAllowedString(value, RESOLUTION_PRESET_OPTIONS)) return value;
  return fallback;
}

/** Normalizes the old numeric self-video size format used before preset selectors existed. */
function normalizeLegacyVideoFormat(value: unknown): LegacyVideoFormat | null {
  if (LEGACY_VIDEO_FORMAT_OPTIONS.includes(value as LegacyVideoFormat)) {
    return value as LegacyVideoFormat;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (LEGACY_VIDEO_FORMAT_OPTIONS.includes(parsed as LegacyVideoFormat)) {
      return parsed as LegacyVideoFormat;
    }
  }
  return null;
}

/** Clones settings so callers never mutate shared in-memory state by accident. */
function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return {
    basic: { ...settings.basic },
    professional: { ...settings.professional },
  };
}

/** Returns the numeric dimensions for a preset key. */
export function getResolutionPresetDimensions(preset: ResolutionPreset): Readonly<ResolutionDimensions> {
  return RESOLUTION_PRESET_DIMENSIONS[preset];
}

/** Finds the preset whose dimensions exactly match the provided size. */
function findPresetByExactDimensions(width: number | null, height: number | null): ResolutionPreset | null {
  if (!width || !height) return null;

  return RESOLUTION_PRESET_OPTIONS.find((preset) => {
    const dimensions = getResolutionPresetDimensions(preset);
    return dimensions.width === width && dimensions.height === height;
  }) ?? null;
}

/** Picks the largest supported preset that still fits within legacy max bounds. */
function findLargestPresetWithin(width: number | null, height: number | null): ResolutionPreset | null {
  if (!width || !height) return null;

  let bestMatch: ResolutionPreset | null = null;
  for (const preset of RESOLUTION_PRESET_OPTIONS) {
    const dimensions = getResolutionPresetDimensions(preset);
    if (dimensions.width <= width && dimensions.height <= height) {
      bestMatch = preset;
    }
  }
  return bestMatch;
}

/** Migrates persisted legacy camera settings to the new preset-based selector. */
function normalizeSelfVideoResolutionPreset(basicCandidate: Record<string, unknown>): ResolutionPreset {
  if (hasAllowedString(basicCandidate.selfVideoResolutionPreset, RESOLUTION_PRESET_OPTIONS)) {
    return basicCandidate.selfVideoResolutionPreset;
  }

  const widthFormat = normalizeLegacyVideoFormat(basicCandidate.selfVideoWidthFormat);
  const heightFormat = normalizeLegacyVideoFormat(basicCandidate.selfVideoHeightFormat);
  const exactLegacyPreset = findPresetByExactDimensions(
    widthFormat ? getResolutionPresetDimensions(LEGACY_CAMERA_FORMAT_TO_PRESET[widthFormat]).width : null,
    heightFormat
  );

  if (exactLegacyPreset) return exactLegacyPreset;
  if (widthFormat) return LEGACY_CAMERA_FORMAT_TO_PRESET[widthFormat];
  return DEFAULT_EXTENSION_SETTINGS.basic.selfVideoResolutionPreset;
}

/** Migrates persisted legacy tab width/height limits to the nearest supported preset. */
function normalizeTabResolutionPreset(professionalCandidate: Record<string, unknown>): ResolutionPreset {
  if (hasAllowedString(professionalCandidate.tabResolutionPreset, RESOLUTION_PRESET_OPTIONS)) {
    return professionalCandidate.tabResolutionPreset;
  }

  const legacyWidth = readPositiveInt(professionalCandidate.tabMaxWidth);
  const legacyHeight = readPositiveInt(professionalCandidate.tabMaxHeight);
  const exactLegacyPreset = findPresetByExactDimensions(legacyWidth, legacyHeight);
  if (exactLegacyPreset) return exactLegacyPreset;

  const boundedPreset = findLargestPresetWithin(legacyWidth, legacyHeight);
  if (boundedPreset) return boundedPreset;

  return DEFAULT_EXTENSION_SETTINGS.professional.tabResolutionPreset;
}

const defaultRecordingMode: RecordingModeDefault =
  EXTENSION_DEFAULTS.configurable.recordingMode;
const defaultMicMode: MicMode = EXTENSION_DEFAULTS.configurable.microphoneRecordingMode;

export const DEFAULT_EXTENSION_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  basic: Object.freeze({
    recordingMode: defaultRecordingMode,
    microphoneRecordingMode: defaultMicMode,
    separateCameraCapture: EXTENSION_DEFAULTS.configurable.separateCameraCapture,
    selfVideoResolutionPreset: DEFAULT_RESOLUTION_PRESET,
  }),
  professional: Object.freeze({
    selfVideoBitrate: EXTENSION_DEFAULTS.capture.selfVideo.defaultBitsPerSecond,
    selfVideoFrameRate: EXTENSION_DEFAULTS.capture.selfVideo.frameRate,
    selfVideoMinAdaptiveBitrate: EXTENSION_DEFAULTS.capture.selfVideo.minAdaptiveBitsPerSecond,
    tabResolutionPreset: DEFAULT_RESOLUTION_PRESET,
    tabMaxFrameRate: EXTENSION_DEFAULTS.capture.tab.maxFrameRate,
    microphoneEchoCancellation: EXTENSION_DEFAULTS.capture.microphone.echoCancellation,
    microphoneNoiseSuppression: EXTENSION_DEFAULTS.capture.microphone.noiseSuppression,
    microphoneAutoGainControl: EXTENSION_DEFAULTS.capture.microphone.autoGainControl,
    chunkDefaultTimesliceMs: EXTENSION_DEFAULTS.chunking.defaultTimesliceMs,
    chunkExtendedTimesliceMs: EXTENSION_DEFAULTS.chunking.extendedTimesliceMs,
  }),
});

let runtimeSettings: ExtensionSettings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);

/** Normalizes any persisted settings payload and migrates legacy field shapes. */
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
    selfVideoResolutionPreset: normalizeSelfVideoResolutionPreset(basicCandidate),
  };

  const professional: ExtensionSettings['professional'] = {
    selfVideoBitrate: normalizePositiveInt(
      professionalCandidate.selfVideoBitrate,
      DEFAULT_EXTENSION_SETTINGS.professional.selfVideoBitrate,
      100_000,
      MAX_SELF_VIDEO_BITRATE
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
    tabResolutionPreset: normalizeTabResolutionPreset(professionalCandidate),
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

/** Returns the current in-memory settings snapshot used by runtime helpers. */
export function getRuntimeExtensionSettings(): Readonly<ExtensionSettings> {
  return runtimeSettings;
}

/** Converts the configurable recording-mode default into the runtime storage mode. */
export function toStorageMode(recordingMode: RecordingModeDefault): StorageMode {
  return recordingMode === 'opfs' ? 'local' : 'drive';
}

/** Builds the popup's default run configuration from persisted extension settings. */
export function buildDefaultRunConfigFromSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): RecordingRunConfig {
  return {
    storageMode: toStorageMode(settings.basic.recordingMode),
    micMode: settings.basic.microphoneRecordingMode,
    recordSelfVideo: settings.basic.separateCameraCapture,
  };
}

/** Returns the numeric self-video profile currently requested from getUserMedia. */
export function getSelfVideoProfileSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): SelfVideoProfileSettings {
  const dimensions = getResolutionPresetDimensions(settings.basic.selfVideoResolutionPreset);
  const { width, height } = dimensions;
  return {
    width,
    height,
    frameRate: settings.professional.selfVideoFrameRate,
    aspectRatio: width / height,
    defaultBitsPerSecond: settings.professional.selfVideoBitrate,
    minAdaptiveBitsPerSecond: settings.professional.selfVideoMinAdaptiveBitrate,
  };
}

/** Returns the numeric tab-output target derived from the selected resolution preset. */
export function getTabOutputSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): TabCaptureSettings {
  const dimensions = getResolutionPresetDimensions(settings.professional.tabResolutionPreset);
  return {
    maxWidth: dimensions.width,
    maxHeight: dimensions.height,
    maxFrameRate: settings.professional.tabMaxFrameRate,
  };
}

/** Preserves the legacy helper name for callers that still expect tab sizing settings. */
export function getTabCaptureSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): TabCaptureSettings {
  return getTabOutputSettings(settings);
}

/** Returns microphone capture constraints used when a mic stream is requested. */
export function getMicrophoneCaptureSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): MicrophoneCaptureSettings {
  return {
    echoCancellation: settings.professional.microphoneEchoCancellation,
    noiseSuppression: settings.professional.microphoneNoiseSuppression,
    autoGainControl: settings.professional.microphoneAutoGainControl,
  };
}

/** Returns recorder chunking timings used by MediaRecorder timeslice selection. */
export function getChunkingSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): ChunkingSettings {
  return {
    defaultTimesliceMs: settings.professional.chunkDefaultTimesliceMs,
    extendedTimesliceMs: settings.professional.chunkExtendedTimesliceMs,
  };
}

/** Loads settings from extension storage and refreshes the in-memory runtime snapshot. */
export async function loadExtensionSettingsFromStorage(): Promise<ExtensionSettings> {
  if (!hasLocalStorageArea()) {
    runtimeSettings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
    return cloneSettings(runtimeSettings);
  }
  const stored = await getLocalStorageValues(EXTENSION_SETTINGS_STORAGE_KEY);
  runtimeSettings = normalizeExtensionSettings(stored[EXTENSION_SETTINGS_STORAGE_KEY]);
  return cloneSettings(runtimeSettings);
}

/** Persists normalized settings to storage and updates the in-memory runtime snapshot. */
export async function saveExtensionSettingsToStorage(value: unknown): Promise<ExtensionSettings> {
  runtimeSettings = normalizeExtensionSettings(value);
  if (hasLocalStorageArea()) {
    await setLocalStorageValues({ [EXTENSION_SETTINGS_STORAGE_KEY]: runtimeSettings });
  }
  return cloneSettings(runtimeSettings);
}

/** Resets persisted settings back to their canonical defaults. */
export async function resetExtensionSettingsToDefaults(): Promise<ExtensionSettings> {
  return await saveExtensionSettingsToStorage(DEFAULT_EXTENSION_SETTINGS);
}
