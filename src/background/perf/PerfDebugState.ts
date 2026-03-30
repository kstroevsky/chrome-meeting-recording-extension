/**
 * @file background/perf/PerfDebugState.ts
 *
 * Initial state factories for the performance diagnostics store.
 */

import type { PerfDebugSnapshot, PerfDebugSummary, PerfSettings } from '../../shared/perf';

export function createEmptySummary(): PerfDebugSummary {
  return {
    currentPhase: 'idle',
    totalEvents: 0,
    countsByScope: {},
    recorder: {
      startCountByStream: {},
      lastStartLatencyMsByStream: {},
      avgStartLatencyMsByStream: {},
      persistedChunkCount: 0,
      persistedChunkBytes: 0,
      avgPersistedChunkDurationMs: null,
      lastPersistedChunkDurationMs: null,
      lastPersistedChunkBytes: null,
      lastTimesliceMs: null,
      lastSelfVideoBitrate: null,
      lastAudioBridgeMode: null,
      lastAudioBridgeSuppressed: null,
      lastAudioBridgeEnabled: null,
    },
    captions: {
      currentObserverCount: 0,
      maxObserverCount: 0,
    },
    upload: {
      chunkCount: 0,
      totalChunkBytes: 0,
      avgChunkDurationMs: null,
      lastChunkDurationMs: null,
      lastChunkBytes: null,
      lastChunkThroughputMbps: null,
      retryCount: 0,
      retriedChunkCount: 0,
      fileCount: 0,
      uploadedCount: 0,
      fallbackCount: 0,
      avgFileDurationMs: null,
      lastFileDurationMs: null,
      lastFallbackRate: null,
      lastConcurrency: null,
    },
    runtime: {
      sampleCount: 0,
      state: 'idle',
      activeRecorders: 0,
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      lastHeapUsedMb: null,
      lastTotalHeapMb: null,
      maxHeapUsedMb: null,
      lastHeapLimitMb: null,
      lastEventLoopLagMs: null,
      avgEventLoopLagMs: null,
      maxEventLoopLagMs: null,
      longTaskCount: 0,
      lastLongTaskMs: null,
      maxLongTaskMs: null,
    },
  };
}

export function createEmptySnapshot(settings: PerfSettings): PerfDebugSnapshot {
  return {
    enabled: settings.debugMode,
    settings,
    updatedAt: null,
    droppedEvents: 0,
    entries: [],
    summary: createEmptySummary(),
  };
}
