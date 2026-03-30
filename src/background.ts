/**
 * @context  Background Service Worker (MV3)
 * @role     Orchestrator for popup, offscreen, downloads, and auth.
 * @lifetime Event-driven. Chrome may suspend and restart this worker at will.
 *
 * Responsibilities:
 *   - Accept user commands from popup (start/stop/status)
 *   - Own tabCapture.getMediaStreamId and chrome.downloads access
 *   - Keep the extension alive while work is active (`starting`, `recording`,
 *     `stopping`, or `uploading`)
 *   - Re-attach to the offscreen document after service worker restarts
 *
 * The worker does not handle media directly. Capture, encoding, OPFS writes,
 * and post-stop Drive upload sequencing all live in the offscreen document.
 */

import { OffscreenManager } from './background/OffscreenManager';
import { PerfDebugStore } from './background/PerfDebugStore';
import { RecordingSession } from './background/RecordingSession';
import { registerMessageHandlers, registerSaveHandler } from './background/messageHandlers';
import { startKeepAlive, stopKeepAlive, maybeClearPerfDiagnostics } from './background/sessionLifecycle';
import { hydrateLegacySession, LEGACY_SESSION_PHASE_KEY, LEGACY_SESSION_RUN_CONFIG_KEY } from './background/legacySession';
import { getSessionStorageValues, setSessionStorageValues } from './platform/chrome/storage';
import { makeLogger } from './shared/logger';
import {
  configurePerfRuntime,
  getPerfSettingsSnapshot,
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
} from './shared/perf';
import {
  isBusyPhase,
  RECORDING_SESSION_STORAGE_KEY,
} from './shared/recording';

const L = makeLogger('background');
const offscreen = new OffscreenManager();

let activeDebugDashboards = 0;
let sessionHydrated = false;

const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), L.warn);
const session = new RecordingSession(
  async (snapshot) => {
    try {
      await setSessionStorageValues({ [RECORDING_SESSION_STORAGE_KEY]: snapshot });
    } catch (error) {
      L.warn('storage.session.set failed (recording session):', error);
    }
  },
  (snapshot) => {
    if (isBusyPhase(snapshot.phase)) {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
    offscreen.hydratePhase(snapshot.phase);
    perfDebugStore.setPhase(snapshot.phase);
    if (!isBusyPhase(snapshot.phase)) {
      maybeClearPerfDiagnostics({ session, perfDebugStore, isSessionHydrated: () => sessionHydrated, getActiveDebugDashboards: () => activeDebugDashboards });
    }
    void import('./shared/messages').then(({ broadcastToPopup }) =>
      broadcastToPopup({ type: 'RECORDING_STATE', session: snapshot })
    );
  }
);

// Wire offscreen -> background save requests and session phase updates.
offscreen.onStateChanged = (msg) => {
  session.applyOffscreenPhase(msg);
};
registerSaveHandler(offscreen, L);

// Register all popup message handlers.
registerMessageHandlers({ L, offscreen, session, perfDebugStore });

// Register port listeners for offscreen and debug dashboard connections.
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name === 'offscreen') {
    offscreen.attachPort(port);
    return;
  }

  if (port.name !== 'debug-dashboard') return;

  activeDebugDashboards += 1;
  port.onDisconnect.addListener(() => {
    activeDebugDashboards = Math.max(0, activeDebugDashboards - 1);
    maybeClearPerfDiagnostics({ session, perfDebugStore, isSessionHydrated: () => sessionHydrated, getActiveDebugDashboards: () => activeDebugDashboards });
  });
});

// Register suspend handler for graceful stop on service-worker sleep.
chrome.runtime.onSuspend?.addListener(async () => {
  await offscreen.stopIfPossibleOnSuspend();
});

// Hydrate persisted session on service-worker (re)start.
(async () => {
  try {
    const settings = await configurePerfRuntime({
      source: 'background',
      sink: (entry) => perfDebugStore.record(entry),
      onSettingsChanged: (nextSettings) => perfDebugStore.setSettings(nextSettings),
    });

    const res = await getSessionStorageValues([
      RECORDING_SESSION_STORAGE_KEY,
      LEGACY_SESSION_PHASE_KEY,
      LEGACY_SESSION_RUN_CONFIG_KEY,
      PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
    ]);
    perfDebugStore.hydrate(res?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY] as PerfDebugSnapshot | undefined);
    perfDebugStore.setSettings(settings);
    const snapshot = session.hydrate(
      res?.[RECORDING_SESSION_STORAGE_KEY] ?? hydrateLegacySession(res)
    );
    if (!isBusyPhase(snapshot.phase)) {
      maybeClearPerfDiagnostics({ session, perfDebugStore, isSessionHydrated: () => sessionHydrated, getActiveDebugDashboards: () => activeDebugDashboards });
    }
    if (isBusyPhase(snapshot.phase)) {
      L.log('SW restarted while offscreen work was active — re-attaching offscreen');
      await offscreen.ensureReady();
      startKeepAlive();
    }
  } catch (e) {
    L.warn('Session re-hydration failed (non-fatal):', e);
  } finally {
    sessionHydrated = true;
    maybeClearPerfDiagnostics({ session, perfDebugStore, isSessionHydrated: () => sessionHydrated, getActiveDebugDashboards: () => activeDebugDashboards });
  }
})();
