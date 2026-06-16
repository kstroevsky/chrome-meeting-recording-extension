/**
 * @file background/phaseWatchdog.ts
 *
 * Liveness backstop for the `starting` phase. The epoch fence (ADR-0003) drops
 * *stale* offscreen status; this rescues a session with *missing* status — one
 * orphaned in `starting` after the service worker died mid-start. In that case the
 * `OFFSCREEN_START` RPC promise is lost with the worker, so nothing drives the
 * session on to `recording`/`failed`; on restart it rehydrates `starting`, pins
 * keep-alive, and sits there forever (the offscreen's reconnect re-broadcast is
 * fenced out by the stale epoch). On timeout the watchdog fails the session and
 * lets the caller tear down the (dead, wedged, or zombie) offscreen so a retry
 * starts clean.
 *
 * Scoped to `starting` only on purpose: the live-service-worker start path is
 * already bounded by `RPC_MS`, and `uploading` legitimately runs for minutes.
 *
 * The remaining budget is measured from the snapshot's `updatedAt`, not from when
 * the timer is armed, so a session rehydrated into a *stale* `starting` (the
 * SW-restart-orphan case) fires immediately rather than granting a fresh budget.
 */

import type { RecordingSessionSnapshot } from '../shared/recording';

type TimerHandle = ReturnType<typeof setTimeout>;

export type PhaseWatchdogDeps = {
  /** How long a session may sit in `starting` before it is considered stuck. */
  budgetMs: number;
  /** Reads the live session snapshot at fire time (re-checked before acting). */
  getSnapshot: () => RecordingSessionSnapshot;
  /** Invoked when a session is still stuck in `starting` after the budget. */
  onStuck: (snapshot: RecordingSessionSnapshot) => void;
  /** Monotonic clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** Timer primitives; injectable for tests. */
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export type PhaseWatchdog = {
  /** (Re)arms the watchdog for `starting`, or clears it for any other phase. */
  observe: (snapshot: RecordingSessionSnapshot) => void;
  /** Cancels any pending timer. */
  stop: () => void;
};

/**
 * Builds a watchdog that fires `onStuck` when a session stays in `starting`
 * longer than `budgetMs`. Drive it from the session change-listener: call
 * `observe(snapshot)` on every transition (including the rehydrated one).
 */
export function createPhaseWatchdog(deps: PhaseWatchdogDeps): PhaseWatchdog {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));

  let handle: TimerHandle | null = null;

  const stop = () => {
    if (handle != null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const observe = (snapshot: RecordingSessionSnapshot) => {
    // Any transition disarms the previous timer; only `starting` re-arms it.
    stop();
    if (snapshot.phase !== 'starting') return;

    const elapsed = now() - snapshot.updatedAt;
    const remaining = Math.max(0, deps.budgetMs - elapsed);
    handle = setTimer(() => {
      handle = null;
      // Re-check at fire time: a transition since arming would have cleared this
      // timer, but guard anyway so we never fail a session that already moved on.
      const current = deps.getSnapshot();
      if (current.phase !== 'starting') return;
      deps.onStuck(current);
    }, remaining);
  };

  return { observe, stop };
}
