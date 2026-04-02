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

export type PerfDebugSummary = {
  currentPhase: PerfPhase;
  totalEvents: number;
  countsByScope: Record<string, number>;
  recorder: {
    startCountByStream: Partial<Record<RecordingStream, number>>;
    lastStartLatencyMsByStream: Partial<Record<RecordingStream, number>>;
    avgStartLatencyMsByStream: Partial<Record<RecordingStream, number>>;
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
