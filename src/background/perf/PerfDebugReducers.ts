/**
 * @file background/perf/PerfDebugReducers.ts
 *
 * State reducers that apply perf events into the aggregated debug summary.
 */

import type { PerfDebugSnapshot, PerfEventEntry, PerfFields } from '../../shared/perf';

export function toNumber(value: PerfFields[string]): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toBoolean(value: PerfFields[string]): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function applyRecorderStarted(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = entry.fields.stream;
  const latencyMs = toNumber(entry.fields.latencyMs);
  const timesliceMs = toNumber(entry.fields.timesliceMs);
  const videoBitsPerSecond = toNumber(entry.fields.videoBitsPerSecond);
  if (stream !== 'tab' && stream !== 'mic' && stream !== 'selfVideo') return;

  const recorder = snapshot.summary.recorder;
  const startCount = (recorder.startCountByStream[stream] ?? 0) + 1;
  recorder.startCountByStream[stream] = startCount;
  if (latencyMs != null) {
    recorder.lastStartLatencyMsByStream[stream] = latencyMs;
    const prevAvg = recorder.avgStartLatencyMsByStream[stream] ?? latencyMs;
    recorder.avgStartLatencyMsByStream[stream] = round(
      ((prevAvg * (startCount - 1)) + latencyMs) / startCount
    );
  }
  if (timesliceMs != null) recorder.lastTimesliceMs = timesliceMs;
  if (videoBitsPerSecond != null) recorder.lastSelfVideoBitrate = videoBitsPerSecond;
}

export function applyRecorderChunk(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const durationMs = toNumber(entry.fields.durationMs);
  const chunkBytes = toNumber(entry.fields.chunkBytes);
  const recorder = snapshot.summary.recorder;
  recorder.persistedChunkCount += 1;
  if (chunkBytes != null) {
    recorder.persistedChunkBytes += chunkBytes;
    recorder.lastPersistedChunkBytes = chunkBytes;
  }
  if (durationMs != null) {
    recorder.lastPersistedChunkDurationMs = durationMs;
    const count = recorder.persistedChunkCount;
    const prevAvg = recorder.avgPersistedChunkDurationMs ?? durationMs;
    recorder.avgPersistedChunkDurationMs = round(((prevAvg * (count - 1)) + durationMs) / count);
  }
}

export function applyAudioBridge(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const recorder = snapshot.summary.recorder;
  recorder.lastAudioBridgeMode = entry.fields.mode === 'auto' ? 'auto' : 'always';
  recorder.lastAudioBridgeSuppressed = toBoolean(entry.fields.suppressLocalAudioPlayback);
  recorder.lastAudioBridgeEnabled = toBoolean(entry.fields.willBridge);
}

export function applySelfVideoStream(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const width = toNumber(entry.fields.width);
  const height = toNumber(entry.fields.height);
  const frameRate = toNumber(entry.fields.frameRate);
  if (width == null || height == null || frameRate == null) return;
  const estimatedPixelsPerSecond = width * height * frameRate;
  snapshot.summary.runtime.activeRecorders = Math.max(
    snapshot.summary.runtime.activeRecorders,
    estimatedPixelsPerSecond > 0 ? snapshot.summary.runtime.activeRecorders : 0
  );
}

export function applyObserverCount(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const count = toNumber(entry.fields.activeBlockObservers);
  if (count == null) return;
  snapshot.summary.captions.currentObserverCount = count;
  snapshot.summary.captions.maxObserverCount = Math.max(
    snapshot.summary.captions.maxObserverCount,
    count
  );
}

export function applyDriveChunk(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const upload = snapshot.summary.upload;
  const chunkBytes = toNumber(entry.fields.chunkBytes);
  const durationMs = toNumber(entry.fields.durationMs);
  const retried = toBoolean(entry.fields.retried);
  const attempts = toNumber(entry.fields.attempts);

  upload.chunkCount += 1;
  if (chunkBytes != null) {
    upload.totalChunkBytes += chunkBytes;
    upload.lastChunkBytes = chunkBytes;
  }
  if (durationMs != null) {
    upload.lastChunkDurationMs = durationMs;
    const prevAvg = upload.avgChunkDurationMs ?? durationMs;
    upload.avgChunkDurationMs = round(((prevAvg * (upload.chunkCount - 1)) + durationMs) / upload.chunkCount);
    if (chunkBytes != null && durationMs > 0) {
      upload.lastChunkThroughputMbps = round((chunkBytes / 1024 / 1024) / (durationMs / 1000));
    }
  }
  if (retried) upload.retriedChunkCount += 1;
  if (attempts != null && attempts > 1) upload.retryCount += attempts - 1;
}

export function applyDriveFile(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const upload = snapshot.summary.upload;
  const totalBytes = toNumber(entry.fields.totalBytes);
  const durationMs = toNumber(entry.fields.durationMs);
  upload.fileCount += 1;
  if (durationMs != null) {
    upload.lastFileDurationMs = durationMs;
    const prevAvg = upload.avgFileDurationMs ?? durationMs;
    upload.avgFileDurationMs = round(((prevAvg * (upload.fileCount - 1)) + durationMs) / upload.fileCount);
  }
  if (totalBytes != null && totalBytes === 0) {
    upload.lastChunkThroughputMbps = upload.lastChunkThroughputMbps;
  }
}

export function applyDriveFileComplete(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const uploaded = toBoolean(entry.fields.uploaded);
  if (uploaded == null) return;
  if (uploaded) {
    snapshot.summary.upload.uploadedCount += 1;
  } else {
    snapshot.summary.upload.fallbackCount += 1;
  }
}

export function applyDriveFinalize(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const fallbackRate = toNumber(entry.fields.fallbackRate);
  const concurrency = toNumber(entry.fields.concurrency);
  if (fallbackRate != null) snapshot.summary.upload.lastFallbackRate = fallbackRate;
  if (concurrency != null) snapshot.summary.upload.lastConcurrency = concurrency;
}

export function applyRuntimeSample(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const runtime = snapshot.summary.runtime;
  runtime.sampleCount += 1;

  const phase = entry.fields.phase;
  if (
    phase === 'idle'
    || phase === 'starting'
    || phase === 'recording'
    || phase === 'stopping'
    || phase === 'uploading'
    || phase === 'failed'
  ) {
    runtime.state = phase;
    snapshot.summary.currentPhase = phase;
  }

  const activeRecorders = toNumber(entry.fields.activeRecorders);
  if (activeRecorders != null) runtime.activeRecorders = activeRecorders;

  const hardwareConcurrency = toNumber(entry.fields.hardwareConcurrency);
  if (hardwareConcurrency != null) runtime.hardwareConcurrency = hardwareConcurrency;

  const deviceMemoryGb = toNumber(entry.fields.deviceMemoryGb);
  if (deviceMemoryGb != null) runtime.deviceMemoryGb = deviceMemoryGb;

  const heapUsedMb = toNumber(entry.fields.usedJSHeapSizeMb);
  if (heapUsedMb != null) {
    runtime.lastHeapUsedMb = heapUsedMb;
    runtime.maxHeapUsedMb = runtime.maxHeapUsedMb == null
      ? heapUsedMb
      : Math.max(runtime.maxHeapUsedMb, heapUsedMb);
  }

  const totalHeapMb = toNumber(entry.fields.totalJSHeapSizeMb);
  if (totalHeapMb != null) runtime.lastTotalHeapMb = totalHeapMb;

  const heapLimitMb = toNumber(entry.fields.jsHeapSizeLimitMb);
  if (heapLimitMb != null) runtime.lastHeapLimitMb = heapLimitMb;

  const eventLoopLagMs = toNumber(entry.fields.eventLoopLagMs);
  if (eventLoopLagMs != null) {
    runtime.lastEventLoopLagMs = eventLoopLagMs;
    const prevAvg = runtime.avgEventLoopLagMs ?? eventLoopLagMs;
    runtime.avgEventLoopLagMs = round(((prevAvg * (runtime.sampleCount - 1)) + eventLoopLagMs) / runtime.sampleCount);
    runtime.maxEventLoopLagMs = runtime.maxEventLoopLagMs == null
      ? eventLoopLagMs
      : Math.max(runtime.maxEventLoopLagMs, eventLoopLagMs);
  }

  const longTaskCount = toNumber(entry.fields.longTaskCount);
  if (longTaskCount != null) runtime.longTaskCount = longTaskCount;

  const lastLongTaskMs = toNumber(entry.fields.lastLongTaskMs);
  if (lastLongTaskMs != null) runtime.lastLongTaskMs = lastLongTaskMs;

  const maxLongTaskMs = toNumber(entry.fields.maxLongTaskMs);
  if (maxLongTaskMs != null) {
    runtime.maxLongTaskMs = runtime.maxLongTaskMs == null
      ? maxLongTaskMs
      : Math.max(runtime.maxLongTaskMs, maxLongTaskMs);
  }
}
