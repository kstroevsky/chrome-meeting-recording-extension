/**
 * @file shared/types/perfTypes.ts
 *
 * Diagnostic logging types for evaluating runtime timing boundaries.
 */

import type { RecordingPhase, RecordingStream } from '../recordingTypes';

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

export type PerfFields = Record<string, string | number | boolean | null | undefined>;

export type PerfEventEntry = {
  source: PerfSource;
  scope: string;
  event: string;
  ts: number;
  fields: Record<string, string | number | boolean | null>;
};

/** Requested vs. delivered microphone DSP constraints for one acquired mic stream. */
export type PerfMicConstraints = {
  requestedEchoCancellation: boolean | null;
  requestedNoiseSuppression: boolean | null;
  requestedAutoGainControl: boolean | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
};

export type PerfDebugSummary = {
  currentPhase: PerfPhase;
  totalEvents: number;
  countsByScope: Record<string, number>;
  capture: {
    attemptCountByStream: Partial<Record<RecordingStream, number>>;
    successCountByStream: Partial<Record<RecordingStream, number>>;
    failureCountByStream: Partial<Record<RecordingStream, number>>;
    lastDurationMsByStream: Partial<Record<RecordingStream, number>>;
    durationMsByStream: Partial<Record<RecordingStream, PerfDistribution>>;
    lastRequestedProfileByStream: Partial<Record<RecordingStream, PerfMediaProfile>>;
    lastDeliveredProfileByStream: Partial<Record<RecordingStream, PerfMediaProfile>>;
    lastMicConstraints: PerfMicConstraints | null;
  };
  recorder: {
    startCountByStream: Partial<Record<RecordingStream, number>>;
    lastStartLatencyMsByStream: Partial<Record<RecordingStream, number>>;
    avgStartLatencyMsByStream: Partial<Record<RecordingStream, number>>;
    persistedChunkCount: number;
    persistedChunkBytes: number;
    chunkCountByStream: Partial<Record<RecordingStream, number>>;
    chunkBytesByStream: Partial<Record<RecordingStream, number>>;
    chunkWriteDurationMsByStream: Partial<Record<RecordingStream, PerfDistribution>>;
    lastChunkThroughputMbpsByStream: Partial<Record<RecordingStream, number>>;
    avgPersistedChunkDurationMs: number | null;
    lastPersistedChunkDurationMs: number | null;
    lastPersistedChunkBytes: number | null;
    lastSealDurationMsByStream: Partial<Record<RecordingStream, number>>;
    lastArtifactBytesByStream: Partial<Record<RecordingStream, number>>;
    lastTimesliceMs: number | null;
    lastTimesliceMsByStream: Partial<Record<RecordingStream, number>>;
    lastSelfVideoBitrate: number | null;
    lastVideoBitsPerSecondByStream: Partial<Record<RecordingStream, number>>;
    lastAudioBridgeMode: AudioPlaybackBridgeMode | null;
    lastAudioBridgeSuppressed: boolean | null;
    lastAudioBridgeEnabled: boolean | null;
  };
  captions: {
    currentObserverCount: number;
    maxObserverCount: number;
    mutationCount: number;
    changedMutationCount: number;
    coalescedMutationCount: number;
    missedMutationCount: number;
    mutationThroughputPerSecond: number | null;
    processingDurationMs: PerfDistribution;
    sourceLatencyMs: PerfDistribution;
  };
  storage: {
    openCount: number;
    openFailureCount: number;
    writeCount: number;
    closeCount: number;
    cleanupCount: number;
    currentPendingWrites: number;
    peakPendingWrites: number;
    openCountByStream: Partial<Record<RecordingStream, number>>;
    writeCountByStream: Partial<Record<RecordingStream, number>>;
    closeCountByStream: Partial<Record<RecordingStream, number>>;
    cleanupCountByStream: Partial<Record<RecordingStream, number>>;
    writtenBytesByStream: Partial<Record<RecordingStream, number>>;
    lastWriteThroughputMbpsByStream: Partial<Record<RecordingStream, number>>;
    openDurationMs: PerfDistribution;
    writeDurationMs: PerfDistribution;
    closeDurationMs: PerfDistribution;
    cleanupDurationMs: PerfDistribution;
  };
  finalization: {
    count: number;
    localSaveCount: number;
    downloadCount: number;
    lastDurationMs: number | null;
    durationMs: PerfDistribution;
    downloadDurationMs: PerfDistribution;
    fileCountByStream: Partial<Record<RecordingStream, number>>;
    uploadedCountByStream: Partial<Record<RecordingStream, number>>;
    fallbackCountByStream: Partial<Record<RecordingStream, number>>;
    fileDurationMsByStream: Partial<Record<RecordingStream, PerfDistribution>>;
  };
  lifecycle: {
    startRequestedCount: number;
    startCompletedCount: number;
    stopRequestedCount: number;
    stopCompletedCount: number;
    failureCount: number;
    warningCount: number;
    activeTracks: number;
    peakActiveTracks: number;
    lastStopDurationMs: number | null;
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

export type PerfDistribution = {
  count: number;
  total: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  last: number | null;
};

export type PerfMediaProfile = {
  width: number | null;
  height: number | null;
  frameRate: number | null;
};
