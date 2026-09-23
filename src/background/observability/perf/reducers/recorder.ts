import type { PerfDebugSnapshot, PerfEventEntry } from '../../../../shared/perf';
import { createEmptyDistribution } from '../PerfDebugState';
import {
  applyDistribution,
  matchingDurationSamples,
  round,
  toBoolean,
  toNumber,
  toRecordingStream,
} from './distribution';

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
      if (throughputMbps != null) recorder.lastChunkThroughputMbpsByStream[stream] = throughputMbps;
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
