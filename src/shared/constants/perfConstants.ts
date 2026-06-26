/**
 * @file shared/constants/perfConstants.ts
 *
 * Core constants and defaults for performance diagnostic logging.
 */

import { isDevBuild } from '../build';
import type { PerfFlags, PerfSettings } from '../types/perfTypes';

export const PERF_SETTINGS_STORAGE_KEY = 'perfSettings';
export const PERF_DEBUG_SNAPSHOT_STORAGE_KEY = 'perfDebugSnapshot';
// Hard ceiling on the retained raw event log. The whole snapshot is persisted to
// chrome.storage.session (~10MB quota) on every event, so an unbounded log would
// eventually exceed quota and silently freeze the persisted copy mid-run. 4000
// keeps the payload to a few MB while leaving a multi-minute window for the
// windowed percentiles; whole-session count/avg/max are maintained incrementally
// and are unaffected by eviction.
export const PERF_EVENT_BUFFER_LIMIT = 4000;

export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  audioPlaybackBridgeMode: 'always',
  adaptiveSelfVideoProfile: true,
  extendedTimeslice: false,
  dynamicDriveChunkSizing: true,
  parallelUploadConcurrency: 2,
  opfsWorkerStorage: true,
  debugMode: isDevBuild(),
};

export const PERF_FLAGS: PerfFlags = {
  audioPlaybackBridgeMode: DEFAULT_PERF_SETTINGS.audioPlaybackBridgeMode,
  adaptiveSelfVideoProfile: DEFAULT_PERF_SETTINGS.adaptiveSelfVideoProfile,
  extendedTimeslice: DEFAULT_PERF_SETTINGS.extendedTimeslice,
  dynamicDriveChunkSizing: DEFAULT_PERF_SETTINGS.dynamicDriveChunkSizing,
  parallelUploadConcurrency: DEFAULT_PERF_SETTINGS.parallelUploadConcurrency,
  opfsWorkerStorage: DEFAULT_PERF_SETTINGS.opfsWorkerStorage,
};
