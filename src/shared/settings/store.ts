/**
 * @file shared/settings/store.ts
 *
 * In-memory runtime cache plus storage persistence and the derive helpers that
 * turn user settings into the concrete numbers the recorder consumes. Internal
 * to the Settings module — the public entry points are re-exported by the index.
 */

import { getLocalStorageValues, hasLocalStorageArea, setLocalStorageValues } from '../../platform/chrome/storage';
import {
  DEFAULT_EXTENSION_SETTINGS,
  EXTENSION_SETTINGS_STORAGE_KEY,
  MAX_TAB_VIDEO_BITRATE,
  TAB_MIN_VIDEO_BITRATE,
  TAB_VIDEO_BITRATE_REFERENCE_PIXELS_PER_SECOND,
} from './defaults';
import type { RecordingRunConfig, StorageMode } from '../recordingTypes';
import {
  cloneRecorderRuntimeSettingsSnapshot,
  cloneSettings,
  getResolutionPresetDimensions,
  normalizeExtensionSettings,
} from './normalize';
import type {
  ChunkingSettings,
  ExtensionSettings,
  MicrophoneCaptureSettings,
  RecorderRuntimeSettingsSnapshot,
  SelfVideoProfileSettings,
  TabCaptureSettings,
} from './model';

let runtimeSettings: ExtensionSettings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);

/** Returns the current in-memory settings snapshot used by runtime helpers. */
export function getRuntimeExtensionSettings(): Readonly<ExtensionSettings> {
  return runtimeSettings;
}

/** Converts the configurable recording-mode default into the runtime storage mode. */
export function toStorageMode(recordingMode: string): StorageMode {
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

/**
 * Scales the configured 1080p reference tab bitrate to the selected resolution
 * and frame rate, clamped to a sane floor/ceiling. Lowering the tab resolution
 * preset therefore lowers the encoded bitrate proportionally.
 */
export function resolveTabVideoBitrate(
  width: number,
  height: number,
  frameRate: number,
  referenceBitrate: number
): number {
  const ratio = (width * height * frameRate) / TAB_VIDEO_BITRATE_REFERENCE_PIXELS_PER_SECOND;
  const scaled = Math.round(referenceBitrate * ratio);
  return Math.min(Math.max(scaled, TAB_MIN_VIDEO_BITRATE), MAX_TAB_VIDEO_BITRATE);
}

/** Returns the numeric tab-output target derived from the selected resolution preset. */
export function getTabOutputSettings(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): TabCaptureSettings {
  const dimensions = getResolutionPresetDimensions(settings.professional.tabResolutionPreset);
  const maxFrameRate = settings.professional.tabMaxFrameRate;
  return {
    maxWidth: dimensions.width,
    maxHeight: dimensions.height,
    maxFrameRate,
    videoBitsPerSecond: resolveTabVideoBitrate(
      dimensions.width,
      dimensions.height,
      maxFrameRate,
      settings.professional.tabVideoBitrate
    ),
  };
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

/** Builds the exact recorder configuration that background should freeze into OFFSCREEN_START. */
export function buildRecorderRuntimeSettingsSnapshot(
  settings: Readonly<ExtensionSettings> = runtimeSettings
): RecorderRuntimeSettingsSnapshot {
  return cloneRecorderRuntimeSettingsSnapshot({
    tab: {
      output: getTabOutputSettings(settings),
    },
    selfVideo: {
      profile: getSelfVideoProfileSettings(settings),
    },
    microphone: getMicrophoneCaptureSettings(settings),
    chunking: getChunkingSettings(settings),
  });
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
