/**
 * @file shared/extensionSettings.ts
 *
 * User-configurable extension settings with storage persistence and runtime
 * normalization helpers.
 */

import { getLocalStorageValues, hasLocalStorageArea, setLocalStorageValues } from '../platform/chrome/storage';
import { DEFAULT_EXTENSION_SETTINGS, EXTENSION_SETTINGS_STORAGE_KEY } from './constants/settingsConstants';
import type { RecordingRunConfig, StorageMode } from './recordingTypes';
import {
  cloneRecorderRuntimeSettingsSnapshot,
  cloneSettings,
  getResolutionPresetDimensions,
  normalizeExtensionSettings,
} from './utils/settingsNormalizer';
import type {
  ChunkingSettings,
  ExtensionSettings,
  MicrophoneCaptureSettings,
  RecorderRuntimeSettingsSnapshot,
  SelfVideoProfileSettings,
  TabCaptureSettings,
} from './types/settingsTypes';

// Re-export constants, types, and normalizers so existing dependencies don't break.
export * from './constants/settingsConstants';
export * from './types/settingsTypes';
export * from './utils/settingsNormalizer';

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
