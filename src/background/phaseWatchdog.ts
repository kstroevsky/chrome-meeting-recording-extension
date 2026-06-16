/**
 * @file background/phaseWatchdog.ts
 *
 * Liveness backstop for the orphan-prone "intent ≠ observed" phases — `starting`
 * and `stopping`. The epoch fence (ADR-0003) drops *stale* offscreen status; this
 * rescues a session with *missing* status — one orphaned after the service worker
 * died mid-start or mid-stop. In that case the in-flight `OFFSCREEN_START` /
 * `OFFSCREEN_STOP` RPC promise is lost with the worker, so nothing drives the
 * session on; on restart it rehydrates into that phase, pins keep-alive, and sits
 * there forever (the offscreen's reconnect re-broadcast is fenced out by the stale
 * epoch). On timeout the watchdog invokes `onStuck`, which fails the session and
 * tears down the (dead, wedged, or zombie) offscreen so a retry starts clean.
 *
 * Which phases are watched — and for how long — is the caller's policy, expressed
 * as a per-phase budget map. `recording`/`uploading`/`idle`/`failed` are deliberately
 * left unwatched: the live start/stop paths are bounded by `RPC_MS`, `uploading`
 * legitimately runs for minutes (and has its own orphan-file recovery), and
 * `recording`/`idle` are steady states. This is the reconciler's "intent has not
 * been met for too long" escalation rule (ADR-0003 Decision 4).
 *
 * The remaining budget is measured from the snapshot's `updatedAt`, not from when
 * the timer is armed, so a session rehydrated into an *already-stale* watched phase
 * (the SW-restart-orphan case) fires immediately rather than granting a fresh budget.
 */

import type { RecordingPhase, RecordingSessionSnapshot } from '../shared/recording';

type TimerHandle = ReturnType<typeof setTimeout>;

export type PhaseWatchdogDeps = {
  /**
   * Per-phase liveness budgets in ms. A phase present here is watched (a session
   * sitting in it longer than its budget is considered stuck); any phase absent
   * here is ignored.
   */
  budgets: Partial<Record<RecordingPhase, number>>;
  /** Reads the live session snapshot at fire time (re-checked before acting). */
  getSnapshot: () => RecordingSessionSnapshot;
  /** Invoked when a session is still stuck in the same watched phase after its budget. */
  onStuck: (snapshot: RecordingSessionSnapshot) => void;
  /** Monotonic clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** Timer primitives; injectable for tests. */
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export type PhaseWatchdog = {
  /** (Re)arms the watchdog for a watched phase, or clears it for an unwatched one. */
  observe: (snapshot: RecordingSessionSnapshot) => void;
  /** Cancels any pending timer. */
  stop: () => void;
};

/**
 * Builds a watchdog that fires `onStuck` when a session stays in one of the
 * `budgets` phases longer than that phase's budget. Drive it from the session
 * change-listener: call `observe(snapshot)` on every transition (including the
 * rehydrated one after a service-worker restart).
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
    // Any transition disarms the previous timer; only a watched phase re-arms it.
    stop();
    const budget = deps.budgets[snapshot.phase];
    if (budget == null) return;

    const armedPhase = snapshot.phase;
    const elapsed = now() - snapshot.updatedAt;
    const remaining = Math.max(0, budget - elapsed);
    handle = setTimer(() => {
      handle = null;
      // Re-check at fire time against the phase we armed for: a transition since
      // arming would have cleared this timer, but guard anyway so we never act on a
      // session that already moved on (or re-armed for a different watched phase).
      const current = deps.getSnapshot();
      if (current.phase !== armedPhase) return;
      deps.onStuck(current);
    }, remaining);
  };

  return { observe, stop };
}
