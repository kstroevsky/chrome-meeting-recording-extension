/**
 * @file shared/constants/perfConstants.ts
 *
 * Core constants and defaults for performance diagnostic logging.
 */

import { isDevBuild } from '../build';
import type { PerfFlags, PerfSettings } from '../types/perfTypes';

export const PERF_SETTINGS_STORAGE_KEY = 'perfSettings';
export const PERF_DEBUG_SNAPSHOT_STORAGE_KEY = 'perfDebugSnapshot';
export const PERF_EVENT_BUFFER_LIMIT = 120;
export const PERF_EVENT_MAX_AGE_MS = 15 * 60 * 1000;

export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  audioPlaybackBridgeMode: 'always',
  adaptiveSelfVideoProfile: false,
  extendedTimeslice: false,
  dynamicDriveChunkSizing: false,
  parallelUploadConcurrency: 1,
  debugMode: isDevBuild(),
};

export const PERF_FLAGS: PerfFlags = {
  audioPlaybackBridgeMode: DEFAULT_PERF_SETTINGS.audioPlaybackBridgeMode,
  adaptiveSelfVideoProfile: DEFAULT_PERF_SETTINGS.adaptiveSelfVideoProfile,
  extendedTimeslice: DEFAULT_PERF_SETTINGS.extendedTimeslice,
  dynamicDriveChunkSizing: DEFAULT_PERF_SETTINGS.dynamicDriveChunkSizing,
  parallelUploadConcurrency: DEFAULT_PERF_SETTINGS.parallelUploadConcurrency,
};
