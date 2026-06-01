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
 *       * uploads them to Drive, falling back to download per file.
 *   - Popup state is observational only; uploads continue even if popup closes.
 */

import { connectRuntimePort, trySendRuntimeMessage } from './platform/chrome/runtime';
import { makeLogger } from './shared/logger';
import { sendToBackground } from './shared/messages';
import { RecorderEngine } from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { describeRuntimeError } from './offscreen/errors';
import { RecordingFinalizer } from './offscreen/RecordingFinalizer';
import { RuntimeSampler } from './offscreen/RuntimeSampler';
import { OffscreenController } from './offscreen/OffscreenController';
import { wirePortHandlers, wireRuntimeListener } from './offscreen/rpcHandlers';
import { configurePerfRuntime, debugPerf, isPerfDebugMode, nowMs, roundMs, type PerfEventEntry } from './shared/perf';

const L = makeLogger('offscreen');
const RUNTIME_SAMPLE_INTERVAL_MS = 2_000;

// Global safety nets so failures are not swallowed by the hidden offscreen page.
window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
L.log('script loaded');

void configurePerfRuntime({
  source: 'offscreen',
  sink: (entry: PerfEventEntry) => void trySendRuntimeMessage({ type: 'PERF_EVENT', entry }),
});

// ─── Runtime state ───────────────────────────────────────────────────────────

let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;

// ─── Runtime diagnostics ─────────────────────────────────────────────────────

const runtimeSampler = new RuntimeSampler(RUNTIME_SAMPLE_INTERVAL_MS, nowMs());

// Phase/warning state machine and stop→finalize coordinator. Services are
// attached below once the engine and finalizer exist.
const controller = new OffscreenController({
  postMessage: (message) => getPort().postMessage(message),
  sampler: runtimeSampler,
  error: L.error,
  now: nowMs,
});

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const supportedEntryTypes = (PerformanceObserver as any).supportedEntryTypes as string[] | undefined;
    if (Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          runtimeSampler.recordLongTask(roundMs(entry.duration));
        }
      });
      observer.observe({ entryTypes: ['longtask'] as any });
    }
  } catch {}
}

// ─── Port lifecycle ──────────────────────────────────────────────────────────

function connectPort(retryDelay = 1_000): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const port = connectRuntimePort('offscreen');
  wirePortHandlers(port, {
    engine,
    getPort,
    connectPort,
    currentPhase: controller.currentPhase,
    isFinalizing: controller.isFinalizing,
    clearWarnings: controller.clearWarnings,
    onStartRequested: controller.onStartRequested,
    onStopRequested: controller.onStopRequested,
    pushState: controller.pushState,
    log: L.log,
    error: L.error,
  });

  port.onDisconnect.addListener(() => {
    L.warn('Port disconnected');
    portRef = null;
    if (reconnectEnabled) {
      L.log(`Scheduling port reconnect in ${retryDelay} ms`);
      setTimeout(() => connectPort(Math.min(retryDelay * 2, 30_000)), retryDelay);
    }
  });

  port.postMessage({ type: 'OFFSCREEN_READY' });
  const warnings = controller.currentWarnings();
  port.postMessage({
    type: 'OFFSCREEN_STATE',
    phase: controller.currentPhase(),
    ...(warnings.length ? { warnings } : {}),
  });
  L.log('READY signaled via Port');
  portRef = port;
  return port;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

// ─── State helpers ───────────────────────────────────────────────────────────

function requestSave(filename: string, blobUrl: string, opfsFilename?: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl, opfsFilename });
}

async function getDriveToken(options?: { refresh?: boolean }): Promise<string> {
  const res = await sendToBackground({ type: 'GET_DRIVE_TOKEN', refresh: options?.refresh === true });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.error}`);
  return res.token;
}

// ─── Core services ───────────────────────────────────────────────────────────

const finalizer = new RecordingFinalizer({
  log: L.log,
  warn: L.warn,
  requestSave,
  getDriveToken,
  reportWarning: controller.reportWarning,
});

const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyPhase: controller.pushState,
  reportWarning: controller.reportWarning,
  openTarget: async (filename: string) => {
    try {
      return await LocalFileTarget.create(filename);
    } catch (e) {
      L.warn('OPFS local target create failed', describeRuntimeError(e));
      throw e;
    }
  },
});

controller.attachServices(engine, finalizer);

// ─── Runtime diagnostics sampling ─────────────────────────────────────────────

function sampleRuntimeMetrics() {
  if (!isPerfDebugMode() || controller.currentPhase() === 'idle') return;
  const diagnostics = runtimeSampler.sample(nowMs());
  const perfMemory = (performance as any)?.memory;
  const nav = navigator as Navigator & { deviceMemory?: number };
  debugPerf(L.log, 'runtime', 'sample', {
    phase: controller.currentPhase(),
    recorderState: engine.getDebugState(),
    activeRecorders: engine.getActiveRecorderCount(),
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    usedJSHeapSizeMb: perfMemory?.usedJSHeapSize != null ? roundMs(perfMemory.usedJSHeapSize / 1024 / 1024) : undefined,
    totalJSHeapSizeMb: perfMemory?.totalJSHeapSize != null ? roundMs(perfMemory.totalJSHeapSize / 1024 / 1024) : undefined,
    jsHeapSizeLimitMb: perfMemory?.jsHeapSizeLimit != null ? roundMs(perfMemory.jsHeapSizeLimit / 1024 / 1024) : undefined,
    eventLoopLagMs: diagnostics.eventLoopLagMs,
    avgEventLoopLagMs: diagnostics.avgEventLoopLagMs,
    maxEventLoopLagMs: diagnostics.maxEventLoopLagMs,
    longTaskCount: diagnostics.longTaskCount,
    lastLongTaskMs: diagnostics.lastLongTaskMs,
    maxLongTaskMs: diagnostics.maxLongTaskMs,
  });
}

setInterval(sampleRuntimeMetrics, RUNTIME_SAMPLE_INTERVAL_MS);

wireRuntimeListener(connectPort);
getPort();
