/**
 * @context  Background Service Worker (MV3)
 * @role     Orchestrator for popup, offscreen, downloads, and auth.
 * @lifetime Event-driven. Chrome may suspend and restart this worker at will.
 *
 * Responsibilities:
 *   - Accept user commands from popup (start/stop/status)
 *   - Own tabCapture.getMediaStreamId and chrome.downloads access
 *   - Keep the extension alive while work is active (`recording` or `uploading`)
 *   - Re-attach to the offscreen document after service worker restarts
 *
 * The worker does not handle media directly. Capture, encoding, OPFS writes,
 * and post-stop Drive upload sequencing all live in the offscreen document.
 */
import { OffscreenManager } from './background/OffscreenManager';
import { PerfDebugStore } from './background/PerfDebugStore';
import { fetchDriveTokenWithFallback } from './background/driveAuth';
import { makeLogger } from './shared/logger';
import type { RecordingPhase, RecordingRunConfig } from './shared/protocol';
import {
  configurePerfRuntime,
  getPerfSettingsSnapshot,
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
  type PerfEventEntry,
} from './shared/perf';

const L = makeLogger('background');
const offscreen = new OffscreenManager();
const SESSION_PHASE_KEY = 'phase';
const SESSION_RUN_CONFIG_KEY = 'activeRunConfig';

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let activeRunConfig: RecordingRunConfig | null = null;
let activeDebugDashboards = 0;
const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), L.warn);

function normalizeRunConfig(value: any): RecordingRunConfig | null {
  if (!value || typeof value !== 'object') return null;
  const storageMode = value.storageMode === 'drive' ? 'drive' : value.storageMode === 'local' ? 'local' : null;
  if (!storageMode) return null;
  return {
    storageMode,
    recordSelfVideo: !!value.recordSelfVideo,
    selfVideoQuality: value.selfVideoQuality === 'high' ? 'high' : 'standard',
  };
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function maybeClearPerfDiagnostics() {
  if (activeDebugDashboards > 0) return;
  if (offscreen.getRecordingStatus() !== 'idle') return;
  perfDebugStore.clear();
}

offscreen.onPhaseChanged = (phase: RecordingPhase) => {
  phase === 'idle' ? stopKeepAlive() : startKeepAlive();
  if (phase === 'idle') {
    activeRunConfig = null;
    offscreen.setRunConfig(null);
  }
  perfDebugStore.setPhase(phase);
  if (phase === 'idle') {
    maybeClearPerfDiagnostics();
  }
  (chrome.storage as any)?.session?.set?.({
    [SESSION_PHASE_KEY]: phase,
    [SESSION_RUN_CONFIG_KEY]: activeRunConfig,
  }).catch?.((e: any) => {
    L.warn('storage.session.set failed (phase/run config):', e);
  });
};

(async () => {
  try {
    const settings = await configurePerfRuntime({
      source: 'background',
      sink: (entry) => perfDebugStore.record(entry),
      onSettingsChanged: (nextSettings) => perfDebugStore.setSettings(nextSettings),
    });

    const res = await chrome.storage.session.get([
      SESSION_PHASE_KEY,
      SESSION_RUN_CONFIG_KEY,
      PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
    ]);
    perfDebugStore.hydrate(res?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY] as PerfDebugSnapshot | undefined);
    perfDebugStore.setSettings(settings);
    const phase = (res?.phase === 'recording' || res?.phase === 'uploading') ? res.phase : 'idle';
    activeRunConfig = phase === 'idle' ? null : normalizeRunConfig(res?.[SESSION_RUN_CONFIG_KEY]);
    offscreen.hydratePhase(phase);
    offscreen.setRunConfig(activeRunConfig);
    perfDebugStore.setPhase(phase);
    if (phase === 'idle') {
      maybeClearPerfDiagnostics();
    }
    if (phase !== 'idle') {
      L.log('SW restarted while offscreen work was active — re-attaching offscreen');
      await offscreen.ensureReady();
      startKeepAlive();
    }
  } catch (e) {
    L.warn('Session re-hydration failed (non-fatal):', e);
  }
})();

chrome.runtime.onConnect.addListener((port) => {
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

function getStreamIdForTab(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!id) return reject(new Error('Empty streamId'));
        resolve(id);
      });
    } catch (e) {
      reject(e as any);
    }
  });
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type === 'PERF_EVENT') {
    perfDebugStore.record(msg.entry as PerfEventEntry);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'GET_DRIVE_TOKEN') {
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
    if (msg?.type === 'START_RECORDING') {
      const tabId: number | undefined = msg.tabId;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'Missing tabId' });
        return;
      }

      L.log('Popup requested START_RECORDING for tabId', tabId);

      try {
        await offscreen.ensureReady();
        L.log('ensureReady() completed');
      } catch (e: any) {
        sendResponse({ ok: false, error: `Offscreen not ready: ${e?.message || e}` });
        return;
      }

      try {
        const streamId = await getStreamIdForTab(tabId);
        const runConfig: RecordingRunConfig = {
          storageMode: msg.storageMode === 'drive' ? 'drive' : 'local',
          recordSelfVideo: !!msg.recordSelfVideo,
          selfVideoQuality: msg.selfVideoQuality === 'high' ? 'high' : 'standard',
        };
        const recordSelfVideo = !!msg.recordSelfVideo;
        const selfVideoQuality = msg.selfVideoQuality === 'high' ? 'high' : 'standard';
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({
          type: 'OFFSCREEN_START',
          streamId,
          storageMode: runConfig.storageMode,
          recordSelfVideo,
          selfVideoQuality,
        } as any);

        L.log('rpc(OFFSCREEN_START) response', r);
        if (r?.ok) {
          activeRunConfig = runConfig;
          offscreen.setRunConfig(activeRunConfig);
          (chrome.storage as any)?.session?.set?.({
            [SESSION_RUN_CONFIG_KEY]: activeRunConfig,
          }).catch?.((e: any) => {
            L.warn('storage.session.set failed (start run config):', e);
          });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: r?.error || 'Failed to start' });
        }
      } catch (e: any) {
        L.error('OFFSCREEN_START failed', e);
        sendResponse({ ok: false, error: `OFFSCREEN_START failed: ${e?.message || e}` });
      }
      return;
    }

    if (msg?.type === 'STOP_RECORDING') {
      try {
        await offscreen.ensureReady();
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' } as any);
        if (!r?.ok) {
          sendResponse({ ok: false, error: r?.error || 'Stop failed in offscreen' });
          return;
        }
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: `STOP failed: ${e?.message || e}` });
      }
      return;
    }

    if (msg?.type === 'GET_RECORDING_STATUS') {
      const phase = offscreen.getRecordingStatus();
      sendResponse({
        phase,
        runConfig: phase === 'idle' ? undefined : (activeRunConfig ?? undefined),
      });
      return;
    }
  })().catch((err) => {
    console.error('[background] top-level error', err);
    sendResponse({ ok: false, error: String(err) });
  });

  return true;
});

chrome.runtime.onSuspend?.addListener(async () => {
  await offscreen.stopIfPossibleOnSuspend();
});
