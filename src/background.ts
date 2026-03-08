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
import { fetchDriveTokenWithFallback } from './background/driveAuth';
import { makeLogger } from './shared/logger';
import type { RecordingPhase } from './shared/protocol';

const L = makeLogger('background');
const offscreen = new OffscreenManager();

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

offscreen.onPhaseChanged = (phase: RecordingPhase) => {
  phase === 'idle' ? stopKeepAlive() : startKeepAlive();
};

(async () => {
  try {
    const res = await chrome.storage.session.get(['phase']);
    const phase = (res?.phase === 'recording' || res?.phase === 'uploading') ? res.phase : 'idle';
    offscreen.hydratePhase(phase);
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
  if (port.name !== 'offscreen') return;
  offscreen.attachPort(port);
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
  if (msg?.type === 'GET_DRIVE_TOKEN') {
    fetchDriveTokenWithFallback()
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
        const storageMode = msg.storageMode;
        const recordSelfVideo = !!msg.recordSelfVideo;
        const selfVideoQuality = msg.selfVideoQuality === 'high' ? 'high' : 'standard';
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({
          type: 'OFFSCREEN_START',
          streamId,
          storageMode,
          recordSelfVideo,
          selfVideoQuality,
        } as any);

        L.log('rpc(OFFSCREEN_START) response', r);
        sendResponse(r?.ok ? { ok: true } : { ok: false, error: r?.error || 'Failed to start' });
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
      sendResponse({ phase: offscreen.getRecordingStatus() });
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
