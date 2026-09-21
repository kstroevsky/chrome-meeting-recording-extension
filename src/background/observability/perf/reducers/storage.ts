import type { PerfDebugSnapshot, PerfDistribution, PerfEventEntry } from '../../../../shared/perf';
import {
  applyDistribution,
  matchingDurationSamples,
  toNumber,
  toRecordingStream,
} from './distribution';

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
        storage.writtenBytesByStream[stream] = (storage.writtenBytesByStream[stream] ?? 0) + chunkBytes;
      }
      const throughputMbps = toNumber(entry.fields.throughputMbps);
      if (throughputMbps != null) storage.lastWriteThroughputMbpsByStream[stream] = throughputMbps;
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
    if (peakPendingBytes != null) storage.maxPendingBytes = Math.max(storage.maxPendingBytes, peakPendingBytes);
  }

  if (distribution && durationMs != null) {
    applyDistribution(
      distribution,
      durationMs,
      matchingDurationSamples(snapshot, 'storage', entry.event)
    );
  }
}
