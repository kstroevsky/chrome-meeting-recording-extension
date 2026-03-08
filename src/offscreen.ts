/**
 * @context  Offscreen Document (MV3)
 * @role     Recording studio and post-stop persistence coordinator.
 * @lifetime Created on demand by background. This context owns every media API
 *           that cannot run inside the MV3 service worker: getUserMedia,
 *           MediaRecorder, AudioContext, and OPFS file handles.
 *
 * Runtime model:
 *   - During recording, all streams write only to local storage targets.
 *   - After stop, this context seals those files and either:
 *       * asks background to download them (local mode), or
 *       * uploads them to Drive sequentially, falling back to download per file.
 *   - Popup state is observational only; uploads continue even if popup closes.
 */
import { makeLogger } from './shared/logger';
import { createPortRpcServer } from './shared/rpc';
import type {
  BgToOffscreenOneWay,
  BgToOffscreenRpc,
  BgToOffscreenRuntime,
  RecordingPhase,
  RpcResponse,
} from './shared/protocol';
import { RecorderEngine } from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { describeRuntimeError } from './offscreen/errors';
import { RecordingFinalizer } from './offscreen/RecordingFinalizer';

const L = makeLogger('offscreen');

// Global safety nets so failures do not disappear into the hidden offscreen page.
window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
L.log('script loaded');

let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;
let currentStorageMode: 'local' | 'drive' = 'local';
let currentPhase: RecordingPhase = 'idle';
let finalizeRunPromise: Promise<void> | null = null;

function connectPort(retryDelay = 1_000): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const port = chrome.runtime.connect({ name: 'offscreen' });
  wirePortHandlers(port);

  port.onDisconnect.addListener(() => {
    L.warn('Port disconnected');
    portRef = null;
    if (reconnectEnabled) {
      L.log(`Scheduling port reconnect in ${retryDelay} ms`);
      setTimeout(() => connectPort(Math.min(retryDelay * 2, 30_000)), retryDelay);
    }
  });

  port.postMessage({ type: 'OFFSCREEN_READY' });
  port.postMessage({ type: 'RECORDING_STATE', phase: currentPhase });
  L.log('READY signaled via Port');

  portRef = port;
  return port;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

function respond(reqId: string, payload: any) {
  const msg: RpcResponse<unknown> = { __respFor: reqId, payload };
  getPort().postMessage(msg);
}

function pushState(phase: RecordingPhase, extra?: Record<string, any>) {
  currentPhase = phase;
  try {
    (chrome.storage as any)?.session?.set?.({ phase }).catch?.((e: any) => {
      L.warn('storage.session.set failed — phase will not persist across SW restarts:', e);
    });
  } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', phase, ...(extra ?? {}) });
}

function requestSave(filename: string, blobUrl: string, opfsFilename?: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl, opfsFilename });
}

async function getDriveToken(_options?: { refresh?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_DRIVE_TOKEN' }, (res) => {
      if (!res) return reject(new Error('No response to GET_DRIVE_TOKEN'));
      if (!res.ok) return reject(new Error(`Token fetch failed: ${res.error}`));
      resolve(res.token);
    });
  });
}

const finalizer = new RecordingFinalizer({
  log: L.log,
  warn: L.warn,
  requestSave,
  getDriveToken,
});

async function finalizeCurrentRecordingRun(): Promise<void> {
  if (finalizeRunPromise) return finalizeRunPromise;

  finalizeRunPromise = (async () => {
    const artifacts = await engine.stop();
    const summary = await finalizer.finalize({
      artifacts,
      storageMode: currentStorageMode,
    });

    pushState('idle', summary ? { uploadSummary: summary } : undefined);
  })()
    .catch((e) => {
      L.error('Stop/finalize pipeline failed', describeRuntimeError(e));
      pushState('idle');
    })
    .finally(() => {
      finalizeRunPromise = null;
    });

  return finalizeRunPromise;
}

const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyPhase: pushState,
  enableMicMix: true,
  openTarget: async (filename: string) => {
    try {
      return await LocalFileTarget.create(filename);
    } catch (e) {
      L.warn('OPFS local target create failed', describeRuntimeError(e));
      throw e;
    }
  },
});

function wirePortHandlers(port: chrome.runtime.Port) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START: async (msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_START' }>) => {
        const streamId = msg.streamId as string | undefined;
        if (!streamId) return { ok: false, error: 'Missing streamId' };
        if (currentPhase !== 'idle' || finalizeRunPromise) {
          return { ok: false, error: `Recorder is busy (${currentPhase})` };
        }

        currentStorageMode = msg.storageMode === 'drive' ? 'drive' : 'local';
        const recordSelfVideo = !!msg.recordSelfVideo;
        const selfVideoQuality = msg.selfVideoQuality === 'high' ? 'high' : 'standard';

        try {
          await engine.startFromStreamId(streamId, { recordSelfVideo, selfVideoQuality });
          return { ok: true };
        } catch (e: any) {
          pushState('idle');
          return { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
        }
      },

      OFFSCREEN_STOP: async () => {
        if (!engine.isRecording()) {
          return { ok: false, error: 'Stop requested but recorder is not active' };
        }

        if (currentStorageMode === 'drive') {
          pushState('uploading');
        }
        void finalizeCurrentRecordingRun();
        return { ok: true };
      },

      OFFSCREEN_STATUS: async () => {
        let phase = currentPhase;
        try {
          const res = await (chrome.storage as any)?.session?.get?.(['phase']);
          if (res?.phase === 'idle' || res?.phase === 'recording' || res?.phase === 'uploading') {
            phase = res.phase;
          }
        } catch (e) {
          L.warn('storage.session.get failed — status may be stale:', e);
        }
        return { phase };
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
            L.warn('Failed to cleanup OPFS file', describeRuntimeError(e));
          }
        }
      },
    },
    (reqId, payload) => respond(reqId, payload),
    L.error
  );
}

getPort();

chrome.runtime.onMessage.addListener((msg: BgToOffscreenRuntime, _sender, sendResponse) => {
  try {
    if ((msg as any)?.type === 'OFFSCREEN_PING') {
      sendResponse({ ok: true, via: 'onMessage' });
      return true;
    }
    if ((msg as any)?.type === 'OFFSCREEN_CONNECT') {
      connectPort();
      sendResponse({ ok: true });
      return true;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
});
