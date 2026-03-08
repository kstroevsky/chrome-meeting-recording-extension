import { isDevBuild } from './build';
import {
  getLocalStorageValues,
  hasLocalStorageArea,
  setLocalStorageValues,
} from '../platform/chrome/storage';
import type { RecordingPhase } from './recording';

export type AudioPlaybackBridgeMode = 'always' | 'auto';
export type PerfSource = 'background' | 'offscreen' | 'captions' | 'popup' | 'unknown';
export type PerfPhase = RecordingPhase;

export type PerfFlags = {
  audioPlaybackBridgeMode: AudioPlaybackBridgeMode;
  adaptiveSelfVideoProfile: boolean;
  extendedTimeslice: boolean;
  dynamicDriveChunkSizing: boolean;
  parallelUploadConcurrency: 1 | 2;
};

export type PerfSettings = PerfFlags & {
  debugMode: boolean;
};

export const PERF_SETTINGS_STORAGE_KEY = 'perfSettings';
export const PERF_DEBUG_SNAPSHOT_STORAGE_KEY = 'perfDebugSnapshot';
export const PERF_EVENT_BUFFER_LIMIT = 120;
export const PERF_EVENT_MAX_AGE_MS = 15 * 60 * 1000;

const DEFAULT_PERF_SETTINGS: PerfSettings = {
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

export type PerfFields = Record<string, string | number | boolean | null | undefined>;
export type PerfEventEntry = {
  source: PerfSource;
  scope: string;
  event: string;
  ts: number;
  fields: Record<string, string | number | boolean | null>;
};

export type PerfDebugSummary = {
  currentPhase: PerfPhase;
  totalEvents: number;
  countsByScope: Record<string, number>;
  recorder: {
    startCountByStream: Partial<Record<'tab' | 'mic' | 'selfVideo', number>>;
    lastStartLatencyMsByStream: Partial<Record<'tab' | 'mic' | 'selfVideo', number>>;
    avgStartLatencyMsByStream: Partial<Record<'tab' | 'mic' | 'selfVideo', number>>;
    persistedChunkCount: number;
    persistedChunkBytes: number;
    avgPersistedChunkDurationMs: number | null;
    lastPersistedChunkDurationMs: number | null;
    lastPersistedChunkBytes: number | null;
    lastTimesliceMs: number | null;
    lastSelfVideoBitrate: number | null;
    lastAudioBridgeMode: AudioPlaybackBridgeMode | null;
    lastAudioBridgeSuppressed: boolean | null;
    lastAudioBridgeEnabled: boolean | null;
  };
  captions: {
    currentObserverCount: number;
    maxObserverCount: number;
  };
  upload: {
    chunkCount: number;
    totalChunkBytes: number;
    avgChunkDurationMs: number | null;
    lastChunkDurationMs: number | null;
    lastChunkBytes: number | null;
    lastChunkThroughputMbps: number | null;
    retryCount: number;
    retriedChunkCount: number;
    fileCount: number;
    uploadedCount: number;
    fallbackCount: number;
    avgFileDurationMs: number | null;
    lastFileDurationMs: number | null;
    lastFallbackRate: number | null;
    lastConcurrency: number | null;
  };
  runtime: {
    sampleCount: number;
    state: PerfPhase;
    activeRecorders: number;
    hardwareConcurrency: number | null;
    deviceMemoryGb: number | null;
    lastHeapUsedMb: number | null;
    lastTotalHeapMb: number | null;
    maxHeapUsedMb: number | null;
    lastHeapLimitMb: number | null;
    lastEventLoopLagMs: number | null;
    avgEventLoopLagMs: number | null;
    maxEventLoopLagMs: number | null;
    longTaskCount: number;
    lastLongTaskMs: number | null;
    maxLongTaskMs: number | null;
  };
};

export type PerfDebugSnapshot = {
  enabled: boolean;
  settings: PerfSettings;
  updatedAt: number | null;
  droppedEvents: number;
  entries: PerfEventEntry[];
  summary: PerfDebugSummary;
};

export type PerfEventSink = (entry: PerfEventEntry) => void | Promise<void>;
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

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
