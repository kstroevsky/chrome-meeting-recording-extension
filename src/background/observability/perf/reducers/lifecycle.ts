import type { PerfDebugSnapshot, PerfEventEntry } from '../../../../shared/perf';
import { toNumber } from './distribution';

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
  if (entry.event === 'stop_completed' && durationMs != null) lifecycle.lastStopDurationMs = durationMs;
}
