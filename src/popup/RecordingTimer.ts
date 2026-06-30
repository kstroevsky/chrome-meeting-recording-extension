/**
 * @file popup/RecordingTimer.ts
 *
 * The popup's pause-aware recording clock. It is driven entirely by the session's
 * `recordedMs` (banked elapsed time) plus `runningSince` (the start of the current
 * live span), so the displayed time naturally excludes paused spans. Extracted from
 * PopupController so the controller stays a thin orchestrator and the clock can be
 * unit-tested in isolation.
 */

import { formatDuration } from './popupStatus';
import type { RecordingPhase, RecordingStatusView } from '../shared/recording';

/** The recording clock re-renders once per second while a live span is running. */
const TIMER_TICK_MS = 1000;

export class RecordingTimer {
  private recordedMs = 0;
  private runningSince: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly el: HTMLElement | null) {}

  /** Syncs the timer fields from the session and starts/stops the 1s tick. */
  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    this.recordedMs = session?.recordedMs ?? 0;
    this.runningSince =
      phase === 'recording' && session?.paused !== true ? (session?.runningSince ?? null) : null;
    this.render();
    if (this.runningSince != null) this.start();
    else this.stop();
  }

  /** Stops the per-second tick (idempotent). */
  stop(): void {
    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private render(): void {
    const elapsed =
      this.recordedMs + (this.runningSince != null ? Date.now() - this.runningSince : 0);
    if (this.el) this.el.textContent = formatDuration(elapsed);
  }

  private start(): void {
    if (this.interval != null) return;
    this.interval = setInterval(() => this.render(), TIMER_TICK_MS);
  }
}
