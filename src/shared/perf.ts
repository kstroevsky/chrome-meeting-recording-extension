export type AudioPlaybackBridgeMode = 'always' | 'auto';

export type PerfFlags = {
  audioPlaybackBridgeMode: AudioPlaybackBridgeMode;
  adaptiveSelfVideoProfile: boolean;
  extendedTimeslice: boolean;
  dynamicDriveChunkSizing: boolean;
  parallelUploadConcurrency: 1 | 2;
};

const DEFAULT_PERF_FLAGS: PerfFlags = {
  audioPlaybackBridgeMode: 'always',
  adaptiveSelfVideoProfile: false,
  extendedTimeslice: false,
  dynamicDriveChunkSizing: false,
  parallelUploadConcurrency: 1,
};

export const PERF_FLAGS: PerfFlags = { ...DEFAULT_PERF_FLAGS };

export type PerfFields = Record<string, string | number | boolean | null | undefined>;

export function resetPerfFlags(): void {
  Object.assign(PERF_FLAGS, DEFAULT_PERF_FLAGS);
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

export function logPerf(log: (...a: any[]) => void, scope: string, event: string, fields?: PerfFields): void {
  if (!fields) {
    log(`[perf:${scope}] ${event}`);
    return;
  }

  const cleaned = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );

  if (Object.keys(cleaned).length === 0) {
    log(`[perf:${scope}] ${event}`);
    return;
  }

  log(`[perf:${scope}] ${event}`, cleaned);
}
