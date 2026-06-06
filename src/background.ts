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
import { RecordingController } from './background/RecordingController';
import { RecordingSession } from './background/RecordingSession';
import { registerMessageHandlers } from './background/messageHandlers';
import { registerRecordingAutoStop } from './background/recordingAutoStop';
import { startKeepAlive, stopKeepAlive, maybeClearPerfDiagnostics, registerSaveHandler } from './background/sessionLifecycle';
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
  toStatusView,
} from './shared/recording';

const L = makeLogger('background');
const offscreen = new OffscreenManager();

let activeDebugDashboards = 0;
let sessionHydrated = false;
// Set when an extension update arrives mid-recording; applied once work finishes.
let pendingReload = false;

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
      if (pendingReload) {
        L.log('Applying deferred update reload now that work has finished');
        chrome.runtime.reload();
      }
    }
    void import('./shared/messages').then(({ broadcastToPopup }) =>
      broadcastToPopup({ type: 'RECORDING_STATE', session: toStatusView(snapshot) })
    );
  }
);

// Wire offscreen -> background save requests and session phase updates.
offscreen.onStateChanged = (msg) => {
  if (session.getSnapshot().phase === 'starting' && msg.phase === 'idle') {
    L.log('Ignoring pre-start offscreen idle state while START_RECORDING is in flight');
    return;
  }
  session.applyOffscreenPhase(msg);
};
registerSaveHandler(offscreen, L);

// The recording control plane: every start/stop trigger drives this one seam.
const controller = new RecordingController({ L, offscreen, session });

// Register all popup message handlers.
registerMessageHandlers({ L, session, perfDebugStore, controller });
registerRecordingAutoStop({ session, controller });

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

// Apply downloaded updates promptly, without interrupting an active recording.
chrome.runtime.onUpdateAvailable?.addListener(() => {
  if (!isBusyPhase(session.getSnapshot().phase)) {
    L.log('Update available; reloading to apply');
    chrome.runtime.reload();
  } else {
    L.log('Update available; deferring reload until current work finishes');
    pendingReload = true;
  }
});

// On update, discard any stale offscreen document so the next recording runs new code.
// If work is in flight, defer to a reload after it finishes rather than tearing it down.
chrome.runtime.onInstalled?.addListener(async (details) => {
  if (details.reason !== 'update') return;
  L.log('Extension updated; refreshing offscreen document');
  const closed = await offscreen.closeForUpdate();
  if (!closed) pendingReload = true;
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
