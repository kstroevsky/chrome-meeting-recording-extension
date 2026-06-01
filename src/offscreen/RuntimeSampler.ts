/**
 * @file offscreen/RuntimeSampler.ts
 *
 * Stateful collector for the offscreen runtime-diagnostics loop: event-loop lag
 * (measured as drift between the expected and actual sample times) and long-task
 * counters. The offscreen entrypoint owns the environment reads (heap, hardware)
 * and the timer; this unit owns only the deterministic accumulation math so it
 * can be unit-tested without a DOM or a live offscreen document.
 */

import { roundMs } from '../shared/utils/mathUtils';

export type RuntimeDiagnosticsSample = {
  eventLoopLagMs: number;
  avgEventLoopLagMs: number;
  maxEventLoopLagMs: number;
  longTaskCount: number;
  lastLongTaskMs: number | undefined;
  maxLongTaskMs: number | undefined;
};

export class RuntimeSampler {
  private expectedSampleAt: number;
  private sampleCount = 0;
  private cumulativeLagMs = 0;
  private maxLagMs = 0;
  private longTaskCount = 0;
  private lastLongTaskMs: number | null = null;
  private maxLongTaskMs = 0;

  constructor(
    private readonly intervalMs: number,
    now: number
  ) {
    this.expectedSampleAt = now + intervalMs;
  }

  /** Rebaselines the lag clock when a new active (non-idle) phase begins. */
  markActivePhaseStart(now: number): void {
    this.expectedSampleAt = now + this.intervalMs;
  }

  /** Records one long task observed by the PerformanceObserver. */
  recordLongTask(durationMs: number): void {
    this.longTaskCount += 1;
    this.lastLongTaskMs = durationMs;
    this.maxLongTaskMs = Math.max(this.maxLongTaskMs, durationMs);
  }

  /** Computes a diagnostics sample for `now` and advances the lag baseline. */
  sample(now: number): RuntimeDiagnosticsSample {
    const eventLoopLagMs = Math.max(0, roundMs(now - this.expectedSampleAt));
    this.sampleCount += 1;
    this.cumulativeLagMs += eventLoopLagMs;
    this.maxLagMs = Math.max(this.maxLagMs, eventLoopLagMs);
    this.expectedSampleAt = now + this.intervalMs;

    return {
      eventLoopLagMs,
      avgEventLoopLagMs: roundMs(this.cumulativeLagMs / this.sampleCount),
      maxEventLoopLagMs: roundMs(this.maxLagMs),
      longTaskCount: this.longTaskCount,
      lastLongTaskMs: this.lastLongTaskMs ?? undefined,
      maxLongTaskMs: this.longTaskCount > 0 ? roundMs(this.maxLongTaskMs) : undefined,
    };
  }
}
