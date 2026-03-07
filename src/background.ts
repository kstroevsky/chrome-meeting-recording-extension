/**
 * @context  Background Service Worker (MV3)
 * @role     Orchestrator — the only context that can call tabCapture and
 *           chrome.downloads. Never handles media (MediaRecorder/AudioContext)
 *           directly; those live in the Offscreen document.
 * @lifetime Event-driven. Chrome will terminate and restart this worker at will.
 *           Do NOT store recording state here that must survive suspension — use
 *           chrome.storage.session (via OffscreenManager) for that.
 *
 * Message flow this file handles:
 *   Popup  →  background  (runtime.sendMessage):  START_RECORDING, STOP_RECORDING, GET_RECORDING_STATUS
 *   Offscreen → background (Port):                OFFSCREEN_READY, RECORDING_STATE, OFFSCREEN_SAVE
 *
 * @see src/background/OffscreenManager.ts  — offscreen lifecycle + Port RPC client
 * @see src/shared/protocol.ts              — all message type definitions
 * @see src/shared/rpc.ts                  — Port-based bidirectional RPC helpers
 */
import { makeLogger } from './shared/logger';
import { OffscreenManager } from './background/OffscreenManager';
import { fetchDriveTokenWithFallback } from './background/driveAuth';

const L = makeLogger('background');

const offscreen = new OffscreenManager();

// ── Keepalive ──────────────────────────────────────────────────────────────
// Prevents SW from being suspended while recording is active.
// chrome.runtime.getPlatformInfo is a zero-cost API call that resets the
// 30 s idle timer. Not a permanent guarantee (Chrome may enforce a hard cap
// in future), but combined with session-storage re-hydration provides
// defence-in-depth for long recordings.
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

offscreen.onRecordingChanged = (recording) => {
  recording ? startKeepAlive() : stopKeepAlive();
};

// ── Session-storage re-hydration ───────────────────────────────────────────
// If the SW is restarted while recording is active, re-attach the offscreen
// port so the badge and popup state are restored.
(async () => {
  try {
    const res = await chrome.storage.session.get(['recording']);
    if (res?.recording === true) {
      L.log('SW restarted during recording — re-attaching offscreen');
      await offscreen.ensureReady();
      startKeepAlive();
    }
  } catch (e) {
    L.warn('Session re-hydration failed (non-fatal):', e);
  }
})();

// Port connection from offscreen.html
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;
  offscreen.attachPort(port);
});

// Stream ID helper (unchanged behavior)
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

// Main message listener
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
    return true; // Keep channel open for async sendResponse
  }

  (async () => {
    if (msg?.type === 'START_RECORDING') {
      const tabId: number | undefined = msg.tabId;
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return; }

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
        const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_START', streamId, storageMode } as any);

        L.log('rpc(OFFSCREEN_START) response', r);

        if (r?.ok) {
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
        await offscreen.rpc({ type: 'OFFSCREEN_STOP' } as any);
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: `STOP failed: ${e?.message || e}` });
      }
      return;
    }

    if (msg?.type === 'GET_RECORDING_STATUS') {
      sendResponse({ recording: offscreen.getRecordingStatus() });
      return;
    }
  })().catch((err) => {
    console.error('[background] top-level error', err);
    sendResponse({ ok: false, error: String(err) });
  });

  return true; // Keep channel open for async sendResponse
});

// Cleanup on suspend
chrome.runtime.onSuspend?.addListener(async () => {
  await offscreen.stopIfPossibleOnSuspend();
});
