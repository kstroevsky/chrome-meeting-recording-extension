import type { PerfDebugSnapshot, PerfEventEntry } from '../../../../shared/perf';
import { round, toNumber } from './distribution';

export function applyRuntimeSample(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const runtime = snapshot.summary.runtime;
  runtime.sampleCount += 1;

  const phase = entry.fields.phase;
  if (
    phase === 'idle'
    || phase === 'starting'
    || phase === 'recording'
    || phase === 'stopping'
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
    runtime.avgEventLoopLagMs = round(
      ((prevAvg * (runtime.sampleCount - 1)) + eventLoopLagMs) / runtime.sampleCount
    );
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
