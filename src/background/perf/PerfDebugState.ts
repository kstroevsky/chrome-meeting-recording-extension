/**
 * @file background/perf/PerfDebugState.ts
 *
 * Initial state factories for the performance diagnostics store.
 */

import type {
  PerfDebugSnapshot,
  PerfDebugSummary,
  PerfDistribution,
  PerfSettings,
} from '../../shared/perf';

export function createEmptyDistribution(): PerfDistribution {
  return {
    count: 0,
    total: 0,
    avg: null,
    p50: null,
    p95: null,
    max: null,
    last: null,
  };
}

export function createEmptySummary(): PerfDebugSummary {
  return {
    currentPhase: 'idle',
    totalEvents: 0,
    countsByScope: {},
    capture: {
      attemptCountByStream: {},
      successCountByStream: {},
      failureCountByStream: {},
      lastDurationMsByStream: {},
      durationMsByStream: {},
      lastRequestedProfileByStream: {},
      lastDeliveredProfileByStream: {},
      lastMicConstraints: null,
    },
    recorder: {
      startCountByStream: {},
      lastStartLatencyMsByStream: {},
      avgStartLatencyMsByStream: {},
      persistedChunkCount: 0,
      persistedChunkBytes: 0,
      chunkCountByStream: {},
      chunkBytesByStream: {},
      chunkWriteDurationMsByStream: {},
      lastChunkThroughputMbpsByStream: {},
      avgPersistedChunkDurationMs: null,
      lastPersistedChunkDurationMs: null,
      lastPersistedChunkBytes: null,
      lastSealDurationMsByStream: {},
      lastArtifactBytesByStream: {},
      lastTimesliceMs: null,
      lastTimesliceMsByStream: {},
      lastSelfVideoBitrate: null,
      lastVideoBitsPerSecondByStream: {},
      lastAudioBridgeMode: null,
      lastAudioBridgeSuppressed: null,
      lastAudioBridgeEnabled: null,
    },
    captions: {
      currentObserverCount: 0,
      maxObserverCount: 0,
      mutationCount: 0,
      changedMutationCount: 0,
      coalescedMutationCount: 0,
      missedMutationCount: 0,
      mutationThroughputPerSecond: null,
      processingDurationMs: createEmptyDistribution(),
      sourceLatencyMs: createEmptyDistribution(),
    },
    storage: {
      openCount: 0,
      openFailureCount: 0,
      writeCount: 0,
      workerWriteCount: 0,
      closeCount: 0,
      cleanupCount: 0,
      currentPendingWrites: 0,
      peakPendingWrites: 0,
      backpressureWarningCount: 0,
      maxPendingBytes: 0,
      openCountByStream: {},
      writeCountByStream: {},
      closeCountByStream: {},
      cleanupCountByStream: {},
      writtenBytesByStream: {},
      lastWriteThroughputMbpsByStream: {},
      openDurationMs: createEmptyDistribution(),
      writeDurationMs: createEmptyDistribution(),
      closeDurationMs: createEmptyDistribution(),
      cleanupDurationMs: createEmptyDistribution(),
    },
    finalization: {
      count: 0,
      localSaveCount: 0,
      downloadCount: 0,
      lastDurationMs: null,
      durationMs: createEmptyDistribution(),
      downloadDurationMs: createEmptyDistribution(),
      fileCountByStream: {},
      uploadedCountByStream: {},
      fallbackCountByStream: {},
      fileDurationMsByStream: {},
    },
    lifecycle: {
      startRequestedCount: 0,
      startCompletedCount: 0,
      stopRequestedCount: 0,
      stopCompletedCount: 0,
      failureCount: 0,
      warningCount: 0,
      activeTracks: 0,
      peakActiveTracks: 0,
      lastStopDurationMs: null,
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
      lastCpuPercent: null,
      avgCpuPercent: null,
      maxCpuPercent: null,
      cpuSampleCount: 0,
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

export function normalizeSummary(
  summary: Partial<PerfDebugSummary> | null | undefined
): PerfDebugSummary {
  const empty = createEmptySummary();
  if (!summary || typeof summary !== 'object') return empty;

  return {
    ...empty,
    ...summary,
    countsByScope: { ...empty.countsByScope, ...summary.countsByScope },
    capture: { ...empty.capture, ...summary.capture },
    recorder: { ...empty.recorder, ...summary.recorder },
    captions: {
      ...empty.captions,
      ...summary.captions,
      processingDurationMs: {
        ...empty.captions.processingDurationMs,
        ...summary.captions?.processingDurationMs,
      },
      sourceLatencyMs: {
        ...empty.captions.sourceLatencyMs,
        ...summary.captions?.sourceLatencyMs,
      },
    },
    storage: {
      ...empty.storage,
      ...summary.storage,
      openDurationMs: {
        ...empty.storage.openDurationMs,
        ...summary.storage?.openDurationMs,
      },
      writeDurationMs: {
        ...empty.storage.writeDurationMs,
        ...summary.storage?.writeDurationMs,
      },
      closeDurationMs: {
        ...empty.storage.closeDurationMs,
        ...summary.storage?.closeDurationMs,
      },
      cleanupDurationMs: {
        ...empty.storage.cleanupDurationMs,
        ...summary.storage?.cleanupDurationMs,
      },
    },
    finalization: {
      ...empty.finalization,
      ...summary.finalization,
      durationMs: {
        ...empty.finalization.durationMs,
        ...summary.finalization?.durationMs,
      },
      downloadDurationMs: {
        ...empty.finalization.downloadDurationMs,
        ...summary.finalization?.downloadDurationMs,
      },
    },
    lifecycle: { ...empty.lifecycle, ...summary.lifecycle },
    upload: { ...empty.upload, ...summary.upload },
    runtime: { ...empty.runtime, ...summary.runtime },
  };
}
