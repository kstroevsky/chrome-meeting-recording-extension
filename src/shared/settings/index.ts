/**
 * @file shared/settings/index.ts
 *
 * The Settings module — load, persist, and derive the recorder configuration.
 *
 * This index is the module's interface: defaults, field validation, legacy
 * migration, and the in-memory cache are implementation details living in
 * defaults.ts / validate.ts / normalize.ts / store.ts and are not exported here.
 * Import settings from this module, never from its internal files.
 */

import type { RecorderRuntimeSettingsSnapshot } from './model';
import {
  buildRecorderRuntimeSettingsSnapshot,
  loadExtensionSettingsFromStorage,
} from './store';

// Runtime settings lifecycle and derived recorder configuration.
export {
  loadExtensionSettingsFromStorage,
  saveExtensionSettingsToStorage,
  resetExtensionSettingsToDefaults,
  buildRecorderRuntimeSettingsSnapshot,
  buildDefaultRunConfigFromSettings,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  getMicrophoneCaptureSettings,
  getChunkingSettings,
  resolveTabVideoBitrate,
} from './store';

export { TAB_MAX_FRAME_RATE } from './defaults';

// Normalization for persisted payloads and snapshots received over RPC.
export {
  normalizeExtensionSettings,
  normalizeRecorderRuntimeSettingsSnapshot,
} from './normalize';

export { DEFAULT_EXTENSION_SETTINGS } from './defaults';

export type {
  ExtensionSettings,
  RecorderRuntimeSettingsSnapshot,
  SelfVideoProfileSettings,
  TabCaptureSettings,
  MicrophoneCaptureSettings,
  ChunkingSettings,
  ResolutionPreset,
} from './model';

/**
 * Loads settings from storage and freezes them into the recorder snapshot in a
 * single call. Collapses the previous load-then-build sequence callers had to
 * perform by hand.
 */
export async function loadRecorderRuntimeSettingsSnapshot(): Promise<RecorderRuntimeSettingsSnapshot> {
  return buildRecorderRuntimeSettingsSnapshot(await loadExtensionSettingsFromStorage());
}
