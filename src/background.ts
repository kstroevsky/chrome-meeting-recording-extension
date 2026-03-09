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
import { fetchDriveTokenWithFallback } from './background/driveAuth';
import { downloadFile } from './platform/chrome/downloads';
import { getSessionStorageValues, setSessionStorageValues } from './platform/chrome/storage';
import { getMediaStreamIdForTab } from './platform/chrome/tabs';
import { pokeRuntime } from './platform/chrome/runtime';
import { makeLogger } from './shared/logger';
import { broadcastToPopup } from './shared/messages';
import {
  isPerfEventMessage,
  isPopupToBgMessage,
  type CommandResult,
} from './shared/protocol';
import {
  configurePerfRuntime,
  getPerfSettingsSnapshot,
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
  type PerfEventEntry,
} from './shared/perf';
import {
  isBusyPhase,
  normalizeRunConfig,
  RECORDING_SESSION_STORAGE_KEY,
  type RecordingSessionSnapshot,
} from './shared/recording';

const L = makeLogger('background');
const offscreen = new OffscreenManager();
const LEGACY_SESSION_PHASE_KEY = 'phase';
const LEGACY_SESSION_RUN_CONFIG_KEY = 'activeRunConfig';

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let activeDebugDashboards = 0;
let sessionHydrated = false;
const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), L.warn);
const session = new RecordingSession(
  async (snapshot) => {
    try {
      await setSessionStorageValues({
        [RECORDING_SESSION_STORAGE_KEY]: snapshot,
      });
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
      maybeClearPerfDiagnostics();
    }
    void broadcastToPopup({ type: 'RECORDING_STATE', session: snapshot });
  }
);

/** Keeps the MV3 service worker alive while recording or upload work is active. */
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => pokeRuntime(), 20_000);
}

/** Stops the keep-alive loop once no busy work remains. */
function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/** Clears stored diagnostics only when the session is idle and no dashboard is attached. */
function maybeClearPerfDiagnostics() {
  if (!sessionHydrated) return;
  if (activeDebugDashboards > 0) return;
  if (isBusyPhase(session.getSnapshot().phase)) return;
  perfDebugStore.clear();
}

offscreen.onStateChanged = (msg) => {
  session.applyOffscreenPhase(msg);
};

offscreen.onSaveRequested = ({ filename, blobUrl, opfsFilename }) => {
  const resolvedFilename =
    typeof filename === 'string' && filename.trim()
      ? filename
      : `google-meet-recording-${Date.now()}.webm`;

  if (!blobUrl) return;

  L.log('Saving OFFSCREEN_SAVE via blobUrl', resolvedFilename);
  void (async () => {
    let cleanupOpfsFilename: string | undefined;

    try {
      await downloadFile({ url: blobUrl, filename: resolvedFilename, saveAs: false });
      cleanupOpfsFilename = opfsFilename;
      await broadcastToPopup({ type: 'RECORDING_SAVED', filename: resolvedFilename });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      L.warn('downloads.download error:', message);
      await broadcastToPopup({ type: 'RECORDING_SAVE_ERROR', filename: resolvedFilename, error: message });
    } finally {
      setTimeout(() => {
        offscreen.revokeBlobUrl(blobUrl, cleanupOpfsFilename);
      }, 10_000);
    }
  })();
};

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
      maybeClearPerfDiagnostics();
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
    maybeClearPerfDiagnostics();
  }
})();

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name === 'offscreen') {
    offscreen.attachPort(port);
    return;
  }

  if (port.name !== 'debug-dashboard') return;

  activeDebugDashboards += 1;
  port.onDisconnect.addListener(() => {
    activeDebugDashboards = Math.max(0, activeDebugDashboards - 1);
    maybeClearPerfDiagnostics();
  });
});

/** Wraps tab-capture stream-id acquisition for easier testing and logging. */
function getStreamIdForTab(tabId: number): Promise<string> {
  return getMediaStreamIdForTab(tabId);
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  if (isPerfEventMessage(msg)) {
    perfDebugStore.record(msg.entry as PerfEventEntry);
    sendResponse({ ok: true });
    return false;
  }

  if (!isPopupToBgMessage(msg)) {
    return false;
  }

  if (msg.type === 'GET_DRIVE_TOKEN') {
    fetchDriveTokenWithFallback({ refresh: msg.refresh === true })
      .then((res) => {
        if (!res.ok) L.warn('GET_DRIVE_TOKEN failed:', res.error);
        sendResponse(res);
      })
      .catch((e: any) => {
        const error = e?.message || String(e);
        L.error('GET_DRIVE_TOKEN unexpected failure:', error);
        sendResponse({ ok: false, error });
      });
    return true;
  }

  (async () => {
    if (msg.type === 'START_RECORDING') {
      if (typeof msg.tabId !== 'number') {
        sendResponse(failureResult('Missing tabId'));
        return;
      }

      const runConfig = normalizeRunConfig(msg.runConfig);
      if (!runConfig) {
        sendResponse(failureResult('Missing or invalid run configuration'));
        return;
      }

      session.start(runConfig);

      L.log('Popup requested START_RECORDING for tabId', msg.tabId);

      try {
        await offscreen.ensureReady();
        L.log('ensureReady() completed');
      } catch (e: any) {
        session.fail(`Offscreen not ready: ${e?.message || e}`);
        sendResponse(failureResult(`Offscreen not ready: ${e?.message || e}`));
        return;
      }

      try {
        const streamId = await getStreamIdForTab(msg.tabId);
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({
          type: 'OFFSCREEN_START',
          streamId,
          runConfig,
        });

        L.log('rpc(OFFSCREEN_START) response', r);
        if (r?.ok) {
          sendResponse(successResult());
        } else {
          session.fail(r?.error || 'Failed to start');
          sendResponse(failureResult(r?.error || 'Failed to start'));
        }
      } catch (e: any) {
        L.error('OFFSCREEN_START failed', e);
        session.fail(`OFFSCREEN_START failed: ${e?.message || e}`);
        sendResponse(failureResult(`OFFSCREEN_START failed: ${e?.message || e}`));
      }
      return;
    }

    if (msg.type === 'STOP_RECORDING') {
      const snapshot = session.getSnapshot();
      if (!isBusyPhase(snapshot.phase)) {
        sendResponse(failureResult('Stop requested but no recording session is active'));
        return;
      }
      session.markStopping();

      try {
        await offscreen.ensureReady();
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' });
        if (!r?.ok) {
          session.fail(r?.error || 'Stop failed in offscreen');
          sendResponse(failureResult(r?.error || 'Stop failed in offscreen'));
          return;
        }
        sendResponse(successResult());
      } catch (e: any) {
        session.fail(`STOP failed: ${e?.message || e}`);
        sendResponse(failureResult(`STOP failed: ${e?.message || e}`));
      }
      return;
    }

    if (msg.type === 'GET_RECORDING_STATUS') {
      sendResponse({ session: session.getSnapshot() });
      return;
    }
  })().catch((err) => {
    console.error('[background] top-level error', err);
    session.fail(String(err));
    sendResponse(failureResult(String(err)));
  });

  return true;
});

chrome.runtime.onSuspend?.addListener(async () => {
  await offscreen.stopIfPossibleOnSuspend();
});

/** Builds a success command result from the latest canonical session snapshot. */
function successResult(): CommandResult {
  return { ok: true, session: session.getSnapshot() };
}

/** Builds a failure command result while preserving the latest canonical session snapshot. */
function failureResult(error: string): CommandResult {
  return { ok: false, error, session: session.getSnapshot() };
}

/** Reconstructs in-session state persisted by pre-refactor versions of the extension. */
function hydrateLegacySession(value: Record<string, unknown> | undefined): RecordingSessionSnapshot | undefined {
  const legacyPhase =
    value?.[LEGACY_SESSION_PHASE_KEY] === 'starting'
    || value?.[LEGACY_SESSION_PHASE_KEY] === 'recording'
    || value?.[LEGACY_SESSION_PHASE_KEY] === 'stopping'
    || value?.[LEGACY_SESSION_PHASE_KEY] === 'uploading'
    || value?.[LEGACY_SESSION_PHASE_KEY] === 'failed'
      ? value[LEGACY_SESSION_PHASE_KEY]
      : value?.[LEGACY_SESSION_PHASE_KEY] === 'idle'
        ? 'idle'
        : null;
  if (!legacyPhase) return undefined;

  return {
    phase: legacyPhase,
    runConfig: legacyPhase === 'idle' ? null : normalizeRunConfig(value?.[LEGACY_SESSION_RUN_CONFIG_KEY]),
    updatedAt: Date.now(),
  };
}
