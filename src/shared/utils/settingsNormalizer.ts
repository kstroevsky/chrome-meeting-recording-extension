/**
 * @file shared/utils/settingsNormalizer.ts
 *
 * Helper utilities for migrating, sanitizing, and cloning extension settings.
 */

import { isRecord } from '../typeGuards';
import {
  DEFAULT_EXTENSION_SETTINGS,
  LEGACY_CAMERA_FORMAT_TO_PRESET,
  LEGACY_VIDEO_FORMAT_OPTIONS,
  MAX_SELF_VIDEO_BITRATE,
  MICROPHONE_MODE_OPTIONS,
  RECORDING_MODE_OPTIONS,
  RESOLUTION_PRESET_DIMENSIONS,
  RESOLUTION_PRESET_OPTIONS,
} from '../constants/settingsConstants';
import {
  validateChunkingSettings,
  validateMicrophoneSettings,
  validateSelfVideoProfile,
  validateTabOutput,
} from './settingsValidators';
import type {
  ExtensionSettings,
  LegacyVideoFormat,
  RecorderRuntimeSettingsSnapshot,
  ResolutionDimensions,
  ResolutionPreset,
} from '../types/settingsTypes';

export { readBoundedPositiveInt } from './settingsValidators';

/** Returns true when a string exactly matches one of the allowed option values. */
export function hasAllowedString<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === 'string' && allowedValues.includes(value as T);
}

/** Normalizes a number-like input into a bounded positive integer or a fallback. */
export function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** Parses a number-like value into a positive integer when possible. */
export function readPositiveInt(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  return rounded > 0 ? rounded : null;
}

/** Normalizes a persisted preset key to one of the supported resolution presets. */
export function normalizeResolutionPreset(value: unknown, fallback: ResolutionPreset): ResolutionPreset {
  if (hasAllowedString(value, RESOLUTION_PRESET_OPTIONS)) return value;
  return fallback;
}

/** Normalizes the old numeric self-video size format used before preset selectors existed. */
export function normalizeLegacyVideoFormat(value: unknown): LegacyVideoFormat | null {
  if (LEGACY_VIDEO_FORMAT_OPTIONS.includes(value as LegacyVideoFormat)) return value as LegacyVideoFormat;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (LEGACY_VIDEO_FORMAT_OPTIONS.includes(parsed as LegacyVideoFormat)) return parsed as LegacyVideoFormat;
  }
  return null;
}

/** Clones settings so callers never mutate shared in-memory state by accident. */
export function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return { basic: { ...settings.basic }, professional: { ...settings.professional } };
}

/** Clones a per-run recorder settings snapshot so callers can safely retain it. */
export function cloneRecorderRuntimeSettingsSnapshot(
  snapshot: Readonly<RecorderRuntimeSettingsSnapshot>
): RecorderRuntimeSettingsSnapshot {
  return {
    tab: { output: { ...snapshot.tab.output } },
    selfVideo: { profile: { ...snapshot.selfVideo.profile } },
    microphone: { ...snapshot.microphone },
    chunking: { ...snapshot.chunking },
  };
}

/** Returns the numeric dimensions for a preset key. */
export function getResolutionPresetDimensions(preset: ResolutionPreset): Readonly<ResolutionDimensions> {
  return RESOLUTION_PRESET_DIMENSIONS[preset];
}

/** Finds the preset whose dimensions exactly match the provided size. */
export function findPresetByExactDimensions(width: number | null, height: number | null): ResolutionPreset | null {
  if (!width || !height) return null;
  return RESOLUTION_PRESET_OPTIONS.find((preset) => {
    const d = getResolutionPresetDimensions(preset);
    return d.width === width && d.height === height;
  }) ?? null;
}

/** Picks the largest supported preset that still fits within legacy max bounds. */
export function findLargestPresetWithin(width: number | null, height: number | null): ResolutionPreset | null {
  if (!width || !height) return null;
  let bestMatch: ResolutionPreset | null = null;
  for (const preset of RESOLUTION_PRESET_OPTIONS) {
    const d = getResolutionPresetDimensions(preset);
    if (d.width <= width && d.height <= height) bestMatch = preset;
  }
  return bestMatch;
}

/** Migrates persisted legacy camera settings to the new preset-based selector. */
export function normalizeSelfVideoResolutionPreset(basicCandidate: Record<string, unknown>): ResolutionPreset {
  if (hasAllowedString(basicCandidate.selfVideoResolutionPreset, RESOLUTION_PRESET_OPTIONS)) {
    return basicCandidate.selfVideoResolutionPreset;
  }
  const widthFormat = normalizeLegacyVideoFormat(basicCandidate.selfVideoWidthFormat);
  const widthForPreset = widthFormat ? getResolutionPresetDimensions(LEGACY_CAMERA_FORMAT_TO_PRESET[widthFormat]).width : null;
  const heightFormat = normalizeLegacyVideoFormat(basicCandidate.selfVideoHeightFormat);
  const exactPreset = findPresetByExactDimensions(widthForPreset, heightFormat);
  if (exactPreset) return exactPreset;
  if (widthFormat) return LEGACY_CAMERA_FORMAT_TO_PRESET[widthFormat];
  return DEFAULT_EXTENSION_SETTINGS.basic.selfVideoResolutionPreset;
}

/** Migrates persisted legacy tab width/height limits to the nearest supported preset. */
export function normalizeTabResolutionPreset(professionalCandidate: Record<string, unknown>): ResolutionPreset {
  if (hasAllowedString(professionalCandidate.tabResolutionPreset, RESOLUTION_PRESET_OPTIONS)) {
    return professionalCandidate.tabResolutionPreset;
  }
  const legacyWidth = readPositiveInt(professionalCandidate.tabMaxWidth);
  const legacyHeight = readPositiveInt(professionalCandidate.tabMaxHeight);
  return findPresetByExactDimensions(legacyWidth, legacyHeight)
    ?? findLargestPresetWithin(legacyWidth, legacyHeight)
    ?? DEFAULT_EXTENSION_SETTINGS.professional.tabResolutionPreset;
}

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
    separateCameraCapture: typeof basicCandidate.separateCameraCapture === 'boolean'
      ? basicCandidate.separateCameraCapture
      : DEFAULT_EXTENSION_SETTINGS.basic.separateCameraCapture,
    selfVideoResolutionPreset: normalizeSelfVideoResolutionPreset(basicCandidate),
  };

  const professional: ExtensionSettings['professional'] = {
    selfVideoBitrate: normalizePositiveInt(professionalCandidate.selfVideoBitrate, DEFAULT_EXTENSION_SETTINGS.professional.selfVideoBitrate, 100_000, MAX_SELF_VIDEO_BITRATE),
    selfVideoFrameRate: normalizePositiveInt(professionalCandidate.selfVideoFrameRate, DEFAULT_EXTENSION_SETTINGS.professional.selfVideoFrameRate, 1, 120),
    selfVideoMinAdaptiveBitrate: normalizePositiveInt(professionalCandidate.selfVideoMinAdaptiveBitrate, DEFAULT_EXTENSION_SETTINGS.professional.selfVideoMinAdaptiveBitrate, 100_000, 50_000_000),
    tabResolutionPreset: normalizeTabResolutionPreset(professionalCandidate),
    tabMaxFrameRate: normalizePositiveInt(professionalCandidate.tabMaxFrameRate, DEFAULT_EXTENSION_SETTINGS.professional.tabMaxFrameRate, 1, 120),
    microphoneEchoCancellation: typeof professionalCandidate.microphoneEchoCancellation === 'boolean'
      ? professionalCandidate.microphoneEchoCancellation
      : DEFAULT_EXTENSION_SETTINGS.professional.microphoneEchoCancellation,
    microphoneNoiseSuppression: typeof professionalCandidate.microphoneNoiseSuppression === 'boolean'
      ? professionalCandidate.microphoneNoiseSuppression
      : DEFAULT_EXTENSION_SETTINGS.professional.microphoneNoiseSuppression,
    microphoneAutoGainControl: typeof professionalCandidate.microphoneAutoGainControl === 'boolean'
      ? professionalCandidate.microphoneAutoGainControl
      : DEFAULT_EXTENSION_SETTINGS.professional.microphoneAutoGainControl,
    chunkDefaultTimesliceMs: normalizePositiveInt(professionalCandidate.chunkDefaultTimesliceMs, DEFAULT_EXTENSION_SETTINGS.professional.chunkDefaultTimesliceMs, 250, 60_000),
    chunkExtendedTimesliceMs: normalizePositiveInt(professionalCandidate.chunkExtendedTimesliceMs, DEFAULT_EXTENSION_SETTINGS.professional.chunkExtendedTimesliceMs, 250, 60_000),
  };

  if (professional.chunkExtendedTimesliceMs < professional.chunkDefaultTimesliceMs) {
    professional.chunkExtendedTimesliceMs = professional.chunkDefaultTimesliceMs;
  }
  if (professional.selfVideoMinAdaptiveBitrate > professional.selfVideoBitrate) {
    professional.selfVideoMinAdaptiveBitrate = professional.selfVideoBitrate;
  }

  return { basic, professional };
}

/** Validates a frozen recorder snapshot received over RPC without applying defaults. */
export function normalizeRecorderRuntimeSettingsSnapshot(value: unknown): RecorderRuntimeSettingsSnapshot | null {
  if (!isRecord(value)) return null;

  const tabCandidate = isRecord(value.tab) ? value.tab : null;
  const tabOutputCandidate = tabCandidate && isRecord(tabCandidate.output) ? tabCandidate.output : null;
  const selfVideoCandidate = isRecord(value.selfVideo) ? value.selfVideo : null;
  const selfVideoProfileCandidate = selfVideoCandidate && isRecord(selfVideoCandidate.profile) ? selfVideoCandidate.profile : null;
  const microphoneCandidate = isRecord(value.microphone) ? value.microphone : null;
  const chunkingCandidate = isRecord(value.chunking) ? value.chunking : null;
  if (!tabOutputCandidate || !selfVideoProfileCandidate || !microphoneCandidate || !chunkingCandidate) return null;

  const tabOutput = validateTabOutput(tabOutputCandidate);
  if (!tabOutput) return null;

  const selfVideoProfile = validateSelfVideoProfile(selfVideoProfileCandidate);
  if (!selfVideoProfile) return null;

  const microphone = validateMicrophoneSettings(microphoneCandidate);
  if (!microphone) return null;

  const chunking = validateChunkingSettings(chunkingCandidate);
  if (!chunking) return null;

  return {
    tab: { output: tabOutput },
    selfVideo: { profile: selfVideoProfile },
    microphone,
    chunking,
  };
}
