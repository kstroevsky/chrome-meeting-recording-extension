import { makeLogger } from './shared/logger';
import { createPortRpcServer } from './shared/rpc';
import type { BgToOffscreenOneWay, BgToOffscreenRpc, BgToOffscreenRuntime, RpcResponse } from './shared/protocol';
import { RecorderEngine } from './offscreen/RecorderEngine';

const L = makeLogger('offscreen');

// Global safety nets
window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
L.log('script loaded');

// --------------------
// Port plumbing
// --------------------
let portRef: chrome.runtime.Port | null = null;

function connectPort(): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const p = chrome.runtime.connect({ name: 'offscreen' });
  p.onDisconnect.addListener(() => {
    L.warn('Port disconnected');
    portRef = null;
  });

  // Tell background we're alive
  p.postMessage({ type: 'OFFSCREEN_READY' });
  L.log('READY signaled via Port');

  portRef = p;
  return p;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

function respond(reqId: string, payload: any) {
  const p = getPort();
  const msg: RpcResponse = { __respFor: reqId, payload };
  p.postMessage(msg);
}

function pushState(recording: boolean, extra?: Record<string, any>) {
  try { (chrome.storage as any)?.session?.set?.({ recording }).catch?.(() => {}); } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...(extra ?? {}) });
}

function requestSave(filename: string, blobUrl: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl });
}

// --------------------
// Engine
// --------------------
const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyState: pushState,
  requestSave,
});

// --------------------
// RPC handlers (Port)
// --------------------
function wirePortHandlers(port: chrome.runtime.Port) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START: async (msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_START' }>) => {
        const streamId = msg.streamId as string | undefined;
        if (!streamId) return { ok: false, error: 'Missing streamId' };

        try {
          await engine.startFromStreamId(streamId);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
        }
      },

      OFFSCREEN_STOP: async () => {
        try {
          engine.stop();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },

      OFFSCREEN_STATUS: async () => {
        // Preserve original behavior: prefer session storage (survives some reload paths),
        // but also reflect in-memory engine state if available.
        let recording = engine.isRecording();
        try {
          const res = await (chrome.storage as any)?.session?.get?.(['recording']);
          if (typeof res?.recording === 'boolean') recording = !!res.recording;
        } catch {}
        return { recording };
      },

      // One-way can still be accepted through same map (no __id)
      REVOKE_BLOB_URL: async (msg: BgToOffscreenOneWay) => {
        if (typeof (msg as any).blobUrl === 'string') engine.revokeBlobUrl((msg as any).blobUrl);
      },
    },
    (reqId, payload) => respond(reqId, payload),
    L.error
  );
}

// Ensure we have a port and handlers wired
wirePortHandlers(getPort());

// --------------------
// Runtime (non-port) fallback handlers
// --------------------
chrome.runtime.onMessage.addListener((msg: BgToOffscreenRuntime, _sender, sendResponse) => {
  try {
    if ((msg as any)?.type === 'OFFSCREEN_PING') { sendResponse({ ok: true, via: 'onMessage' }); return true; }
    if ((msg as any)?.type === 'OFFSCREEN_CONNECT') { connectPort(); sendResponse({ ok: true }); return true; }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
});
