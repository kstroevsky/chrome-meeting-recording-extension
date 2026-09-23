import type { PerfDebugSnapshot, PerfEventEntry } from '../../../../shared/perf';
import { applyDistribution, matchingDurationSamples, toNumber, toRecordingStream } from './distribution';

export function applyFinalization(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const finalization = snapshot.summary.finalization;
  const stream = toRecordingStream(entry.fields.stream);
  const durationMs = toNumber(entry.fields.durationMs);
  if (entry.event === 'local_save_requested') {
    finalization.localSaveCount += 1;
    if (stream && entry.fields.reason !== 'fallback') {
      finalization.fileCountByStream[stream] = (finalization.fileCountByStream[stream] ?? 0) + 1;
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
