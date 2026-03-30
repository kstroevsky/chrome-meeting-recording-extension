/**
 * @file shared/perf.ts
 *
 * Cross-context perf flags, event types, and persisted debug settings used by
 * background, offscreen, captions, popup, and the diagnostics dashboard.
 */

import { isDevBuild } from './build';
import {
  getLocalStorageValues,
  hasLocalStorageArea,
  setLocalStorageValues,
} from '../platform/chrome/storage';
import { DEFAULT_PERF_SETTINGS, PERF_FLAGS, PERF_SETTINGS_STORAGE_KEY } from './constants/perfConstants';
import type { PerfEventEntry, PerfEventSink, PerfFields, PerfSettings, PerfSource } from './types/perfTypes';

export * from './constants/perfConstants';
export * from './types/perfTypes';
export * from './utils/mathUtils';

type ConfigurePerfRuntimeOptions = {
  source: PerfSource;
  sink?: PerfEventSink;
  onSettingsChanged?: (settings: PerfSettings) => void;
};

let debugMode = DEFAULT_PERF_SETTINGS.debugMode;
let perfSource: PerfSource = 'unknown';
let perfSink: PerfEventSink | null = null;
let storageWatchInstalled = false;

function cleanPerfFields(fields?: PerfFields): Record<string, string | number | boolean | null> {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Record<string, string | number | boolean | null>;
}

function hasChromeStorage(): boolean {
  return hasLocalStorageArea();
}

export function normalizePerfSettings(raw?: unknown): PerfSettings {
  const value = (raw && typeof raw === 'object') ? raw as Partial<PerfSettings> : {};
  return {
    audioPlaybackBridgeMode: value.audioPlaybackBridgeMode === 'auto' ? 'auto' : DEFAULT_PERF_SETTINGS.audioPlaybackBridgeMode,
    adaptiveSelfVideoProfile: value.adaptiveSelfVideoProfile === true,
    extendedTimeslice: value.extendedTimeslice === true,
    dynamicDriveChunkSizing: value.dynamicDriveChunkSizing === true,
    parallelUploadConcurrency: value.parallelUploadConcurrency === 2 ? 2 : DEFAULT_PERF_SETTINGS.parallelUploadConcurrency,
    debugMode: isDevBuild(),
  };
}

export function getPerfSettingsSnapshot(): PerfSettings {
  return {
    audioPlaybackBridgeMode: PERF_FLAGS.audioPlaybackBridgeMode,
    adaptiveSelfVideoProfile: PERF_FLAGS.adaptiveSelfVideoProfile,
    extendedTimeslice: PERF_FLAGS.extendedTimeslice,
    dynamicDriveChunkSizing: PERF_FLAGS.dynamicDriveChunkSizing,
    parallelUploadConcurrency: PERF_FLAGS.parallelUploadConcurrency,
    debugMode,
  };
}

export function applyPerfSettings(raw?: unknown): PerfSettings {
  const settings = normalizePerfSettings(raw);
  PERF_FLAGS.audioPlaybackBridgeMode = settings.audioPlaybackBridgeMode;
  PERF_FLAGS.adaptiveSelfVideoProfile = settings.adaptiveSelfVideoProfile;
  PERF_FLAGS.extendedTimeslice = settings.extendedTimeslice;
  PERF_FLAGS.dynamicDriveChunkSizing = settings.dynamicDriveChunkSizing;
  PERF_FLAGS.parallelUploadConcurrency = settings.parallelUploadConcurrency;
  debugMode = settings.debugMode;
  return settings;
}

export async function readStoredPerfSettings(): Promise<PerfSettings> {
  if (!hasChromeStorage()) return getPerfSettingsSnapshot();
  try {
    const res = await getLocalStorageValues(PERF_SETTINGS_STORAGE_KEY);
    return normalizePerfSettings(res?.[PERF_SETTINGS_STORAGE_KEY]);
  } catch {
    return getPerfSettingsSnapshot();
  }
}

export async function updateStoredPerfSettings(partial: Partial<PerfSettings>): Promise<PerfSettings> {
  const current = await readStoredPerfSettings();
  const next = normalizePerfSettings({ ...current, ...partial });
  applyPerfSettings(next);
  if (!hasChromeStorage()) return next;
  try {
    await setLocalStorageValues({ [PERF_SETTINGS_STORAGE_KEY]: next });
  } catch {}
  return next;
}

export async function configurePerfRuntime(options: ConfigurePerfRuntimeOptions): Promise<PerfSettings> {
  perfSource = options.source;
  perfSink = options.sink ?? null;

  const settings = applyPerfSettings(await readStoredPerfSettings());
  options.onSettingsChanged?.(settings);

  if (!storageWatchInstalled && typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
    storageWatchInstalled = true;
    chrome.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local') return;
      if (!changes?.[PERF_SETTINGS_STORAGE_KEY]) return;
      const next = applyPerfSettings(changes[PERF_SETTINGS_STORAGE_KEY].newValue);
      options.onSettingsChanged?.(next);
    });
  }

  return settings;
}

export function isPerfDebugMode(): boolean {
  return debugMode;
}

export function resetPerfFlags(): void {
  applyPerfSettings(DEFAULT_PERF_SETTINGS);
  perfSource = 'unknown';
  perfSink = null;
  storageWatchInstalled = false;
}

function emitPerfEntry(scope: string, event: string, fields: Record<string, string | number | boolean | null>): void {
  if (!debugMode || !perfSink) return;
  const entry: PerfEventEntry = {
    source: perfSource,
    scope,
    event,
    ts: Date.now(),
    fields,
  };
  try {
    void perfSink(entry);
  } catch {}
}

export function logPerf(log: (...a: any[]) => void, scope: string, event: string, fields?: PerfFields): void {
  const cleaned = cleanPerfFields(fields);
  void log;
  emitPerfEntry(scope, event, cleaned);
}

export function debugPerf(log: (...a: any[]) => void, scope: string, event: string, fields?: PerfFields): void {
  if (!debugMode) return;
  logPerf(log, scope, event, fields);
}
