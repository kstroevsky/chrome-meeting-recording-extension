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
import { connectRuntimePort, trySendRuntimeMessage } from './platform/chrome/runtime';
import { makeLogger } from './shared/logger';
import { sendToBackground } from './shared/messages';
import { createPortRpcServer } from './shared/rpc';
import type {
  BgToOffscreenOneWay,
  BgToOffscreenRpc,
  BgToOffscreenRuntime,
  RpcResponse,
} from './shared/protocol';
import { isBgToOffscreenRuntimeMessage } from './shared/protocol';
import { RecorderEngine } from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { describeRuntimeError } from './offscreen/errors';
import { RecordingFinalizer } from './offscreen/RecordingFinalizer';
import { configurePerfRuntime, debugPerf, isPerfDebugMode, nowMs, roundMs, type PerfEventEntry } from './shared/perf';
import { normalizeRunConfig, type RecordingPhase, type RecordingRunConfig } from './shared/recording';

const L = makeLogger('offscreen');
const RUNTIME_SAMPLE_INTERVAL_MS = 2_000;

// Global safety nets so failures do not disappear into the hidden offscreen page.
window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
L.log('script loaded');

function sendPerfEvent(entry: PerfEventEntry) {
  void trySendRuntimeMessage({ type: 'PERF_EVENT', entry });
}

void configurePerfRuntime({
  source: 'offscreen',
  sink: sendPerfEvent,
});

let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;
let currentStorageMode: 'local' | 'drive' = 'local';
let currentPhase: RecordingPhase = 'idle';
let currentRunConfig: RecordingRunConfig | null = null;
let finalizeRunPromise: Promise<void> | null = null;
let expectedRuntimeSampleAt = nowMs() + RUNTIME_SAMPLE_INTERVAL_MS;
let runtimeSampleCount = 0;
let cumulativeEventLoopLagMs = 0;
let maxEventLoopLagMs = 0;
let longTaskCount = 0;
let lastLongTaskMs: number | null = null;
let maxLongTaskMs = 0;

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const supportedEntryTypes = (PerformanceObserver as any).supportedEntryTypes as string[] | undefined;
    if (Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const durationMs = roundMs(entry.duration);
          longTaskCount += 1;
          lastLongTaskMs = durationMs;
          maxLongTaskMs = Math.max(maxLongTaskMs, durationMs);
        }
      });
      observer.observe({ entryTypes: ['longtask'] as any });
    }
  } catch {}
}

function connectPort(retryDelay = 1_000): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const port = connectRuntimePort('offscreen');
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
  port.postMessage({ type: 'OFFSCREEN_STATE', phase: currentPhase });
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
  if (phase !== currentPhase && phase !== 'idle') {
    expectedRuntimeSampleAt = nowMs() + RUNTIME_SAMPLE_INTERVAL_MS;
  }
  currentPhase = phase;
  getPort().postMessage({ type: 'OFFSCREEN_STATE', phase, ...(extra ?? {}) });
}

function requestSave(filename: string, blobUrl: string, opfsFilename?: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl, opfsFilename });
}

async function getDriveToken(options?: { refresh?: boolean }): Promise<string> {
  const res = await sendToBackground({ type: 'GET_DRIVE_TOKEN', refresh: options?.refresh === true });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.error}`);
  return res.token;
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
    if (currentStorageMode === 'drive' && artifacts.length > 0) {
      pushState('uploading');
    }
    const summary = await finalizer.finalize({
      artifacts,
      storageMode: currentStorageMode,
    });
    currentRunConfig = null;
    pushState('idle', summary ? { uploadSummary: summary } : undefined);
  })()
    .catch((e) => {
      L.error('Stop/finalize pipeline failed', describeRuntimeError(e));
      currentRunConfig = null;
      pushState('failed', { error: describeRuntimeError(e) });
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
  openTarget: async (filename: string) => {
    try {
      return await LocalFileTarget.create(filename);
    } catch (e) {
      L.warn('OPFS local target create failed', describeRuntimeError(e));
      throw e;
    }
  },
});

function sampleRuntimeMetrics() {
  if (!isPerfDebugMode() || currentPhase === 'idle') return;
  const now = nowMs();
  const eventLoopLagMs = Math.max(0, roundMs(now - expectedRuntimeSampleAt));
  runtimeSampleCount += 1;
  cumulativeEventLoopLagMs += eventLoopLagMs;
  maxEventLoopLagMs = Math.max(maxEventLoopLagMs, eventLoopLagMs);
  expectedRuntimeSampleAt = now + RUNTIME_SAMPLE_INTERVAL_MS;
  const perfMemory = (performance as any)?.memory;
  const nav = navigator as Navigator & { deviceMemory?: number };
  debugPerf(L.log, 'runtime', 'sample', {
    phase: currentPhase,
    recorderState: engine.getDebugState(),
    activeRecorders: engine.getActiveRecorderCount(),
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    usedJSHeapSizeMb: perfMemory?.usedJSHeapSize != null ? roundMs(perfMemory.usedJSHeapSize / 1024 / 1024) : undefined,
    totalJSHeapSizeMb: perfMemory?.totalJSHeapSize != null ? roundMs(perfMemory.totalJSHeapSize / 1024 / 1024) : undefined,
    jsHeapSizeLimitMb: perfMemory?.jsHeapSizeLimit != null ? roundMs(perfMemory.jsHeapSizeLimit / 1024 / 1024) : undefined,
    eventLoopLagMs,
    avgEventLoopLagMs: runtimeSampleCount > 0 ? roundMs(cumulativeEventLoopLagMs / runtimeSampleCount) : undefined,
    maxEventLoopLagMs: roundMs(maxEventLoopLagMs),
    longTaskCount,
    lastLongTaskMs: lastLongTaskMs ?? undefined,
    maxLongTaskMs: longTaskCount > 0 ? roundMs(maxLongTaskMs) : undefined,
  });
}

setInterval(sampleRuntimeMetrics, RUNTIME_SAMPLE_INTERVAL_MS);

function wirePortHandlers(port: chrome.runtime.Port) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START: async (msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_START' }>) => {
        const streamId = msg.streamId as string | undefined;
        const runConfig = normalizeRunConfig(msg.runConfig);
        if (!streamId) return { ok: false, error: 'Missing streamId' };
        if (!runConfig) return { ok: false, error: 'Missing run configuration' };
        if (currentPhase !== 'idle' || finalizeRunPromise) {
          return { ok: false, error: `Recorder is busy (${currentPhase})` };
        }

        currentRunConfig = runConfig;
        currentStorageMode = runConfig.storageMode;
        pushState('starting');

        try {
          await engine.startFromStreamId(streamId, runConfig);
          return { ok: true };
        } catch (e: any) {
          currentRunConfig = null;
          const error = `${e?.name || 'Error'}: ${e?.message || e}`;
          pushState('failed', { error });
          return { ok: false, error };
        }
      },

      OFFSCREEN_STOP: async () => {
        if (!engine.isRecording()) {
          return { ok: false, error: 'Stop requested but recorder is not active' };
        }

        pushState('stopping');
        void finalizeCurrentRecordingRun();
        return { ok: true };
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

chrome.runtime.onMessage.addListener((
  msg: BgToOffscreenRuntime,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => {
  try {
    if (isBgToOffscreenRuntimeMessage(msg)) {
      connectPort();
      sendResponse({ ok: true });
      return true;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
});
