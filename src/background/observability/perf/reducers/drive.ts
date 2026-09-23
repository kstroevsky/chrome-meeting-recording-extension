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
