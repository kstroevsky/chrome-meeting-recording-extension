import type { PerfDebugSnapshot, PerfEventEntry } from '../../../../shared/perf';
import {
  applyDistribution,
  round,
  toBoolean,
  toNumber,
} from './distribution';

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
      mutationEntries
        .map((candidate) => toNumber(candidate.fields.durationMs))
        .filter((value): value is number => value != null)
    );
  }
  const sourceLatencyMs = toNumber(entry.fields.sourceLatencyMs);
  if (sourceLatencyMs != null) {
    applyDistribution(
      captions.sourceLatencyMs,
      sourceLatencyMs,
      mutationEntries
        .map((candidate) => toNumber(candidate.fields.sourceLatencyMs))
        .filter((value): value is number => value != null)
    );
  }
}

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
