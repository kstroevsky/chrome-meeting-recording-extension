/**
 * @context  Offscreen Document (MV3)
 * @role     Recording Studio — the only context that can run MediaRecorder and
 *           AudioContext. Chrome creates this as a hidden, DOM-capable page.
 * @lifetime Created on-demand by OffscreenManager when recording starts.
 *           Chrome may have at most ONE offscreen document at a time per extension.
 *
 * Communication:
 *   All recording commands arrive via a persistent chrome.runtime.Port ('offscreen').
 *   Using a Port (vs sendMessage) avoids re-opening a channel per message and allows
 *   bidirectional streaming. The offscreen document proactively connects on load.
 *
 *   A secondary chrome.runtime.onMessage handler exists ONLY for the startup handshake:
 *     OFFSCREEN_CONNECT — lets Background trigger a Port reconnect when the offscreen
 *                         is already running but its Port has disconnected
 *   Normal recording RPC always flows through the Port.
 *
 * @see src/offscreen/RecorderEngine.ts  — media capture, mixing, and saving
 * @see src/shared/protocol.ts           — all message type definitions
 * @see src/shared/rpc.ts               — Port-based bidirectional RPC helpers
 */
import { makeLogger } from './shared/logger';
import { createPortRpcServer } from './shared/rpc';
import type { BgToOffscreenOneWay, BgToOffscreenRpc, BgToOffscreenRuntime, RpcResponse } from './shared/protocol';
import { RecorderEngine } from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { DriveTarget } from './offscreen/DriveTarget';

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
// All recording commands flow through a persistent chrome.runtime.Port named
// 'offscreen'. The Background attaches to this port via chrome.runtime.onConnect.
// The offscreen side proactively calls connectPort() on load and re-wires the RPC
// server handlers each time the port is (re)created.
let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;

function connectPort(retryDelay = 1_000): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const p = chrome.runtime.connect({ name: 'offscreen' });

  // IMPORTANT: re-wire RPC handlers on EVERY new port instance
  wirePortHandlers(p);

  p.onDisconnect.addListener(() => {
    L.warn('Port disconnected');
    portRef = null;
    if (reconnectEnabled) {
      L.log(`Scheduling port reconnect in ${retryDelay} ms`);
      setTimeout(() => connectPort(Math.min(retryDelay * 2, 30_000)), retryDelay);
    }
  });

  // tell background alive
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
  // RpcResponse<unknown> at the transport layer — the client cast it to the correct TRes
  const msg: RpcResponse<unknown> = { __respFor: reqId, payload };
  p.postMessage(msg);
}

function pushState(recording: boolean, extra?: Record<string, any>) {
  // Persist recording state to session storage so it survives a popup re-open.
  // storage.session is MV3-only and may be unavailable in some configurations;
  // we warn once so it's visible in DevTools instead of silently failing.
  try {
    (chrome.storage as any)?.session?.set?.({ recording }).catch?.((e: any) => {
      L.warn('storage.session.set failed — recording state will not persist across SW restarts:', e);
    });
  } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...(extra ?? {}) });
}

function requestSave(filename: string, blobUrl: string, opfsFilename?: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl, opfsFilename });
}

// --------------------
// Engine
// --------------------
let currentStorageMode: 'local' | 'drive' = 'local';

async function getDriveToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_DRIVE_TOKEN' }, (res) => {
      if (!res) return reject(new Error('No response to GET_DRIVE_TOKEN'));
      if (!res.ok) return reject(new Error(`Token fetch failed: ${res.error}`));
      resolve(res.token);
    });
  });
}

const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyState: pushState,
  requestSave,
  enableMicMix: true, // record local microphone alongside tab audio
  openTarget: async (filename: string) => {
    if (currentStorageMode === 'drive') {
      return new DriveTarget(filename, getDriveToken, (driveFilename) => {
        L.log('Drive target complete:', driveFilename);
      });
    }

    if (await LocalFileTarget.isAvailable()) {
      return LocalFileTarget.create(filename, (blobUrl, opfsFilename) => {
        requestSave(filename, blobUrl, opfsFilename);
      });
    }
    throw new Error('OPFS unavailable');
  }
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
        
        currentStorageMode = msg.storageMode === 'drive' ? 'drive' : 'local';

        try {
          await engine.startFromStreamId(streamId);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
        }
      },

      OFFSCREEN_STOP: async () => {
        reconnectEnabled = false; // Intentionally stopping
        try {
          engine.stop();
          return { ok: true };
        } catch (e) {
          reconnectEnabled = true; // Stop failed, allow reconnect
          return { ok: false, error: String(e) };
        }
      },

      OFFSCREEN_STATUS: async () => {
        let recording = engine.isRecording();
        try {
          const res = await (chrome.storage as any)?.session?.get?.(['recording']);
          if (typeof res?.recording === 'boolean') recording = !!res.recording;
        } catch (e) {
          L.warn('storage.session.get failed — status may be stale:', e);
        }
        return { recording };
      },

      REVOKE_BLOB_URL: async (msg: Extract<BgToOffscreenOneWay, { type: 'REVOKE_BLOB_URL' }>) => {
        const { blobUrl, opfsFilename } = msg;
        if (typeof blobUrl === 'string') engine.revokeBlobUrl(blobUrl);

        if (typeof opfsFilename === 'string') {
          try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(opfsFilename);
            L.log('Cleaned up OPFS file', opfsFilename);
          } catch (e) {
            L.warn('Failed to cleanup OPFS file', e);
          }
        }
      },
    },
    (reqId, payload) => respond(reqId, payload),
    L.error
  );
}

// Ensure a port exists at startup
getPort();

// --------------------
// Runtime (non-port) fallback handlers — startup handshake ONLY
// --------------------
// These handlers use chrome.runtime.onMessage (not a Port) so they work even
// before the Port is established. Background calls OFFSCREEN_PING to verify
// the script loaded, then OFFSCREEN_CONNECT if the Port handshake timed out.
// Once the Port is live, ALL further communication goes through wirePortHandlers().
chrome.runtime.onMessage.addListener((msg: BgToOffscreenRuntime, _sender, sendResponse) => {
  try {
    if ((msg as any)?.type === 'OFFSCREEN_PING') { sendResponse({ ok: true, via: 'onMessage' }); return true; }
    if ((msg as any)?.type === 'OFFSCREEN_CONNECT') { connectPort(); sendResponse({ ok: true }); return true; }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
});
