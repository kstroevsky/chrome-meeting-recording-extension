/**
 * @file background/sessionLifecycle.ts
 *
 * Manages the service-worker keep-alive loop and perf diagnostics clearing
 * that are driven by recording session phase transitions.
 */

import { pokeRuntime } from '../platform/chrome/runtime';
import { isBusyPhase } from '../shared/recording';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';

export type SessionLifecycleDeps = {
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  isSessionHydrated: () => boolean;
  getActiveDebugDashboards: () => number;
};

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Keeps the MV3 service worker alive while recording or upload work is active. */
export function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => pokeRuntime(), 20_000);
}

/** Stops the keep-alive loop once no busy work remains. */
export function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/**
 * Clears stored diagnostics only when the session is idle and no debug dashboard
 * is open. Called after phase changes and after initial hydration.
 */
export function maybeClearPerfDiagnostics(deps: SessionLifecycleDeps) {
  if (!deps.isSessionHydrated()) return;
  if (deps.getActiveDebugDashboards() > 0) return;
  if (isBusyPhase(deps.session.getSnapshot().phase)) return;
  deps.perfDebugStore.clear();
}
