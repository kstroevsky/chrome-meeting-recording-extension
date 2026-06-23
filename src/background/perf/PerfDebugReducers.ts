/**
 * @file background/perf/PerfDebugReducers.ts
 *
 * State reducers that apply perf events into the aggregated debug summary.
 */

import type {
  PerfDebugSnapshot,
  PerfDistribution,
  PerfEventEntry,
  PerfFields,
  PerfMediaProfile,
} from '../../shared/perf';
import type { RecordingStream } from '../../shared/recording';
import { createEmptyDistribution } from './PerfDebugState';

export function toNumber(value: PerfFields[string]): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toBoolean(value: PerfFields[string]): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function toRecordingStream(value: PerfFields[string]): RecordingStream | null {
  return value === 'tab' || value === 'mic' || value === 'self-video' ? value : null;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return round(sorted[index]);
}

function applyDistribution(
  distribution: PerfDistribution,
  value: number,
  samples: number[]
): void {
  distribution.count += 1;
  distribution.total = round(distribution.total + value);
  distribution.avg = round(distribution.total / distribution.count);
  distribution.p50 = percentile(samples, 0.5);
  distribution.p95 = percentile(samples, 0.95);
  distribution.max = distribution.max == null ? value : Math.max(distribution.max, value);
  distribution.last = value;
}

function matchingDurationSamples(
  snapshot: Readonly<PerfDebugSnapshot>,
  scope: string,
  event: string,
  stream?: RecordingStream
): number[] {
  return snapshot.entries
    .filter((candidate) =>
      candidate.scope === scope
      && candidate.event === event
      && (stream == null || candidate.fields.stream === stream)
    )
    .map((candidate) => toNumber(candidate.fields.durationMs))
    .filter((value): value is number => value != null);
}

function readProfile(entry: PerfEventEntry, prefix: 'requested' | ''): PerfMediaProfile {
  const field = (name: string) => prefix ? `${prefix}${name}` : name[0].toLowerCase() + name.slice(1);
  return {
    width: toNumber(entry.fields[field('Width')]),
    height: toNumber(entry.fields[field('Height')]),
    frameRate: toNumber(entry.fields[field('FrameRate')]),
  };
}

export function applyCapture(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = toRecordingStream(entry.fields.stream);
  if (!stream) return;
  const capture = snapshot.summary.capture;
  capture.attemptCountByStream[stream] = (capture.attemptCountByStream[stream] ?? 0) + 1;
  const durationMs = toNumber(entry.fields.durationMs);
  if (entry.event === 'stream_acquired') {
    capture.successCountByStream[stream] = (capture.successCountByStream[stream] ?? 0) + 1;
    capture.lastRequestedProfileByStream[stream] = readProfile(entry, 'requested');
    capture.lastDeliveredProfileByStream[stream] = readProfile(entry, '');
    if (stream === 'mic') {
      capture.lastMicConstraints = {
        requestedEchoCancellation: toBoolean(entry.fields.requestedEchoCancellation),
        requestedNoiseSuppression: toBoolean(entry.fields.requestedNoiseSuppression),
        requestedAutoGainControl: toBoolean(entry.fields.requestedAutoGainControl),
        echoCancellation: toBoolean(entry.fields.echoCancellation),
        noiseSuppression: toBoolean(entry.fields.noiseSuppression),
        autoGainControl: toBoolean(entry.fields.autoGainControl),
      };
    }
  } else {
    capture.failureCountByStream[stream] = (capture.failureCountByStream[stream] ?? 0) + 1;
  }
  if (durationMs == null) return;
  capture.lastDurationMsByStream[stream] = durationMs;
  const distribution = capture.durationMsByStream[stream] ?? createEmptyDistribution();
  applyDistribution(
    distribution,
    durationMs,
    matchingDurationSamples(snapshot, 'capture', entry.event, stream)
  );
  capture.durationMsByStream[stream] = distribution;
}

export function applyRecorderStarted(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = entry.fields.stream;
  const latencyMs = toNumber(entry.fields.latencyMs);
  const timesliceMs = toNumber(entry.fields.timesliceMs);
  const videoBitsPerSecond = toNumber(entry.fields.videoBitsPerSecond);
  if (stream !== 'tab' && stream !== 'mic' && stream !== 'self-video') return;

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
  if (timesliceMs != null) {
    recorder.lastTimesliceMs = timesliceMs;
    recorder.lastTimesliceMsByStream[stream] = timesliceMs;
  }
  if (videoBitsPerSecond != null) {
    recorder.lastVideoBitsPerSecondByStream[stream] = videoBitsPerSecond;
    // Preserve the legacy single field as the camera bitrate specifically.
    if (stream === 'self-video') recorder.lastSelfVideoBitrate = videoBitsPerSecond;
  }
}

export function applyRecorderChunk(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const durationMs = toNumber(entry.fields.durationMs);
  const chunkBytes = toNumber(entry.fields.chunkBytes);
  const recorder = snapshot.summary.recorder;
  const stream = toRecordingStream(entry.fields.stream);
  recorder.persistedChunkCount += 1;
  if (stream) {
    recorder.chunkCountByStream[stream] = (recorder.chunkCountByStream[stream] ?? 0) + 1;
  }
  if (chunkBytes != null) {
    recorder.persistedChunkBytes += chunkBytes;
    recorder.lastPersistedChunkBytes = chunkBytes;
    if (stream) {
      recorder.chunkBytesByStream[stream] = (recorder.chunkBytesByStream[stream] ?? 0) + chunkBytes;
      const throughputMbps = toNumber(entry.fields.throughputMbps);
      if (throughputMbps != null) {
        recorder.lastChunkThroughputMbpsByStream[stream] = throughputMbps;
      }
    }
  }
  if (durationMs != null) {
    recorder.lastPersistedChunkDurationMs = durationMs;
    const count = recorder.persistedChunkCount;
    const prevAvg = recorder.avgPersistedChunkDurationMs ?? durationMs;
    recorder.avgPersistedChunkDurationMs = round(((prevAvg * (count - 1)) + durationMs) / count);
    if (stream) {
      const distribution = recorder.chunkWriteDurationMsByStream[stream] ?? createEmptyDistribution();
      applyDistribution(
        distribution,
        durationMs,
        matchingDurationSamples(snapshot, 'recorder', 'chunk_persisted', stream)
      );
      recorder.chunkWriteDurationMsByStream[stream] = distribution;
    }
  }
}

export function applyRecorderBitrateObserved(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = toRecordingStream(entry.fields.stream);
  if (!stream) return;
  const actual = toNumber(entry.fields.actualBitsPerSecond);
  const ratio = toNumber(entry.fields.ratio);
  const recorder = snapshot.summary.recorder;
  if (actual != null) recorder.lastObservedBitsPerSecondByStream[stream] = actual;
  if (ratio != null) recorder.lastObservedBitrateRatioByStream[stream] = ratio;
}

export function applyArtifactSealed(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = toRecordingStream(entry.fields.stream);
  if (!stream) return;
  const durationMs = toNumber(entry.fields.durationMs);
  const artifactBytes = toNumber(entry.fields.artifactBytes);
  if (durationMs != null) snapshot.summary.recorder.lastSealDurationMsByStream[stream] = durationMs;
  if (artifactBytes != null) snapshot.summary.recorder.lastArtifactBytesByStream[stream] = artifactBytes;
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

export function applyCaptionMutation(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const captions = snapshot.summary.captions;
  captions.mutationCount += 1;
  const mutationEntries = snapshot.entries.filter((candidate) =>
    candidate.scope === 'captions' && candidate.event === 'mutation_processed'
  );
  if (mutationEntries.length >= 2) {
    const elapsedMs = mutationEntries[mutationEntries.length - 1].ts - mutationEntries[0].ts;
    if (elapsedMs > 0) {
      captions.mutationThroughputPerSecond = round(
        ((mutationEntries.length - 1) / elapsedMs) * 1_000
      );
    }
  }
  if (toBoolean(entry.fields.changed)) captions.changedMutationCount += 1;
  if (toBoolean(entry.fields.coalesced)) {
    captions.coalescedMutationCount += 1;
    captions.missedMutationCount += 1;
  }
  const durationMs = toNumber(entry.fields.durationMs);
  if (durationMs != null) {
    applyDistribution(
      captions.processingDurationMs,
      durationMs,
      matchingDurationSamples(snapshot, 'captions', 'mutation_processed')
    );
  }
  const sourceLatencyMs = toNumber(entry.fields.sourceLatencyMs);
  if (sourceLatencyMs != null) {
    applyDistribution(
      captions.sourceLatencyMs,
      sourceLatencyMs,
      snapshot.entries
        .filter((candidate) =>
          candidate.scope === 'captions'
          && candidate.event === 'mutation_processed'
        )
        .map((candidate) => toNumber(candidate.fields.sourceLatencyMs))
        .filter((value): value is number => value != null)
    );
  }
}

/**
 * Accumulates content-script main-thread long tasks. The producer emits one
 * aggregate per PerformanceObserver batch (count/totalMs/maxMs) rather than per
 * entry, so counts add, total accumulates, and max is the running peak.
 */
export function applyCaptionLongTask(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const captions = snapshot.summary.captions;
  const count = toNumber(entry.fields.count);
  const totalMs = toNumber(entry.fields.totalMs);
  const maxMs = toNumber(entry.fields.maxMs);
  if (count != null) captions.longTaskCount += count;
  if (totalMs != null) captions.longTaskTotalMs = round(captions.longTaskTotalMs + totalMs);
  if (maxMs != null) {
    captions.maxLongTaskMs = captions.maxLongTaskMs == null
      ? maxMs
      : Math.max(captions.maxLongTaskMs, maxMs);
  }
}

export function applyStorage(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const storage = snapshot.summary.storage;
  const stream = toRecordingStream(entry.fields.stream);
  const durationMs = toNumber(entry.fields.durationMs);
  const pendingWrites = toNumber(entry.fields.pendingWrites);
  const peakPendingWrites = toNumber(entry.fields.peakPendingWrites);
  if (pendingWrites != null) {
    storage.currentPendingWrites = pendingWrites;
    storage.peakPendingWrites = Math.max(storage.peakPendingWrites, pendingWrites);
  }
  if (peakPendingWrites != null) {
    storage.peakPendingWrites = Math.max(storage.peakPendingWrites, peakPendingWrites);
  }

  let distribution: PerfDistribution | null = null;
  if (entry.event === 'opfs_opened') {
    storage.openCount += 1;
    if (stream) storage.openCountByStream[stream] = (storage.openCountByStream[stream] ?? 0) + 1;
    distribution = storage.openDurationMs;
  } else if (entry.event === 'opfs_open_failed') {
    storage.openFailureCount += 1;
  } else if (entry.event === 'opfs_write_complete') {
    storage.writeCount += 1;
    if (entry.fields.worker === true) storage.workerWriteCount += 1;
    if (stream) {
      storage.writeCountByStream[stream] = (storage.writeCountByStream[stream] ?? 0) + 1;
      const chunkBytes = toNumber(entry.fields.chunkBytes);
      if (chunkBytes != null) {
        storage.writtenBytesByStream[stream] =
          (storage.writtenBytesByStream[stream] ?? 0) + chunkBytes;
      }
      const throughputMbps = toNumber(entry.fields.throughputMbps);
      if (throughputMbps != null) {
        storage.lastWriteThroughputMbpsByStream[stream] = throughputMbps;
      }
    }
    distribution = storage.writeDurationMs;
  } else if (entry.event === 'opfs_closed') {
    storage.closeCount += 1;
    if (stream) storage.closeCountByStream[stream] = (storage.closeCountByStream[stream] ?? 0) + 1;
    distribution = storage.closeDurationMs;
  } else if (entry.event === 'opfs_cleanup') {
    storage.cleanupCount += 1;
    if (stream) storage.cleanupCountByStream[stream] = (storage.cleanupCountByStream[stream] ?? 0) + 1;
    distribution = storage.cleanupDurationMs;
  } else if (entry.event === 'write_backpressure') {
    storage.backpressureWarningCount += 1;
    const peakPendingBytes = toNumber(entry.fields.peakPendingBytes);
    if (peakPendingBytes != null) {
      storage.maxPendingBytes = Math.max(storage.maxPendingBytes, peakPendingBytes);
    }
  }

  if (distribution && durationMs != null) {
    applyDistribution(
      distribution,
      durationMs,
      matchingDurationSamples(snapshot, 'storage', entry.event)
    );
  }
}

export function applyFinalization(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const finalization = snapshot.summary.finalization;
  const stream = toRecordingStream(entry.fields.stream);
  const durationMs = toNumber(entry.fields.durationMs);
  if (entry.event === 'local_save_requested') {
    finalization.localSaveCount += 1;
    if (stream && entry.fields.reason !== 'fallback') {
      finalization.fileCountByStream[stream] =
        (finalization.fileCountByStream[stream] ?? 0) + 1;
    }
  }
  if (entry.event === 'download_complete') {
    finalization.downloadCount += 1;
    if (durationMs != null) {
      applyDistribution(
        finalization.downloadDurationMs,
        durationMs,
        matchingDurationSamples(snapshot, 'finalizer', 'download_complete')
      );
    }
    return;
  }
  if (entry.event !== 'finalize_complete') return;
  finalization.count += 1;
  if (durationMs != null) {
    finalization.lastDurationMs = durationMs;
    applyDistribution(
      finalization.durationMs,
      durationMs,
      matchingDurationSamples(snapshot, 'finalizer', 'finalize_complete')
    );
  }
}

export function applyLifecycle(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const lifecycle = snapshot.summary.lifecycle;
  if (entry.event === 'start_requested') lifecycle.startRequestedCount += 1;
  if (entry.event === 'start_completed') lifecycle.startCompletedCount += 1;
  if (entry.event === 'stop_requested') lifecycle.stopRequestedCount += 1;
  if (entry.event === 'stop_completed') lifecycle.stopCompletedCount += 1;
  if (entry.event === 'failure') lifecycle.failureCount += 1;
  if (entry.event === 'warning') lifecycle.warningCount += 1;
  const activeTracks = toNumber(entry.fields.activeTracks);
  if (activeTracks != null) {
    lifecycle.activeTracks = activeTracks;
    lifecycle.peakActiveTracks = Math.max(lifecycle.peakActiveTracks, activeTracks);
  }
  const durationMs = toNumber(entry.fields.durationMs);
  if (entry.event === 'stop_completed' && durationMs != null) {
    lifecycle.lastStopDurationMs = durationMs;
  }
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
  const stream = toRecordingStream(entry.fields.stream);
  if (uploaded) {
    snapshot.summary.upload.uploadedCount += 1;
    if (stream) {
      snapshot.summary.finalization.uploadedCountByStream[stream] =
        (snapshot.summary.finalization.uploadedCountByStream[stream] ?? 0) + 1;
    }
  } else {
    snapshot.summary.upload.fallbackCount += 1;
    if (stream) {
      snapshot.summary.finalization.fallbackCountByStream[stream] =
        (snapshot.summary.finalization.fallbackCountByStream[stream] ?? 0) + 1;
    }
  }
  if (stream) {
    snapshot.summary.finalization.fileCountByStream[stream] =
      (snapshot.summary.finalization.fileCountByStream[stream] ?? 0) + 1;
    const durationMs = toNumber(entry.fields.durationMs);
    if (durationMs != null) {
      const distribution = snapshot.summary.finalization.fileDurationMsByStream[stream]
        ?? createEmptyDistribution();
      applyDistribution(
        distribution,
        durationMs,
        matchingDurationSamples(snapshot, 'finalizer', 'drive_file_complete', stream)
      );
      snapshot.summary.finalization.fileDurationMsByStream[stream] = distribution;
    }
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

/**
 * Reduces a `runtime:cpu` event (system-wide CPU %, fed by the background-side
 * CpuSampler in dev builds). Tracks last / running-average / peak. Carries its
 * own sample counter because CPU samples can be skipped (no baseline / read
 * error) independently of the runtime samples.
 */
export function applyCpuSample(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const cpuPercent = toNumber(entry.fields.cpuPercent);
  if (cpuPercent == null) return;

  const runtime = snapshot.summary.runtime;
  runtime.lastCpuPercent = cpuPercent;
  runtime.cpuSampleCount += 1;
  const n = runtime.cpuSampleCount;
  const prevAvg = runtime.avgCpuPercent ?? cpuPercent;
  runtime.avgCpuPercent = round(((prevAvg * (n - 1)) + cpuPercent) / n);
  runtime.maxCpuPercent = runtime.maxCpuPercent == null
    ? cpuPercent
    : Math.max(runtime.maxCpuPercent, cpuPercent);
}
