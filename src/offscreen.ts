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

import { RetainedMediaStore } from './offscreen/storage/RetainedMediaStore';
import { connectRuntimePort, trySendRuntimeMessage } from './platform/chrome/runtime';
import { addStorageChangedListener, hasLocalStorageArea } from './platform/chrome/storage';
import { getBuildId } from './shared/build';
import { makeLogger } from './shared/logger';
import { sendToBackground } from './shared/messages';
import { RecorderEngine } from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { WorkerStorageTarget } from './offscreen/storage/WorkerStorageTarget';
import { describeRuntimeError } from './offscreen/errors';
import { RecordingFinalizer } from './offscreen/RecordingFinalizer';
import { UploadManager } from './offscreen/UploadManager';
import { createChromePendingUploadStore } from './offscreen/drive/PendingUploadStore';
import { createChromeUploadJobStateOutbox } from './offscreen/drive/UploadJobStateOutbox';
import { renameDriveResources } from './offscreen/drive/DriveMetadataRenamer';
import { resumePendingDriveUploadsWithChrome } from './offscreen/drive/resumePendingUploads';
import { recoverOrphanRecordingsWithChrome } from './offscreen/storage/recoverOrphanRecordings';
import { RuntimeSampler } from './offscreen/RuntimeSampler';
import { OffscreenController } from './offscreen/OffscreenController';
import { wirePortHandlers, wireRuntimeListener } from './offscreen/rpcHandlers';
import { configurePerfRuntime, debugPerf, isPerfDebugMode, nowMs, roundMs, PERF_FLAGS, type PerfEventEntry } from './shared/perf';
import { loadExtensionSettingsFromStorage, normalizeExtensionSettings } from './shared/settings';
import { TelemetryAccumulator, type TelemetrySink } from './shared/telemetry';

const L = makeLogger('offscreen');
const RUNTIME_SAMPLE_INTERVAL_MS = 2_000;
const PRODUCTION_RUNTIME_SAMPLE_INTERVAL_MS = 10_000;

let telemetryEnabled = true;
let activeTelemetryRunId: string | null = null;
let lastProductionRuntimeSampleAt = 0;
const telemetryRuns = new Map<string, TelemetryAccumulator>();
const telemetryDriveRuns = new Set<string>();
const telemetryUploadJobsStarted = new Set<string>();

const telemetryProxy: TelemetrySink = {
  increment: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.increment(...args),
  measure: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.measure(...args),
  context: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.context(...args),
  incident: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.incident(...args),
  checkpoint: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.checkpoint(...args),
  flush: (...args) => activeTelemetryRunId && telemetryRuns.get(activeTelemetryRunId)?.flush(...args),
};

function beginTelemetryRun(runId: string): void {
  activeTelemetryRunId = runId;
  lastProductionRuntimeSampleAt = Date.now();
  runtimeSampler.reset(nowMs());
  productionRuntimeSampler.reset(nowMs());
  if (!telemetryEnabled) return;
  const accumulator = new TelemetryAccumulator(runId, 'offscreen', {
    onCheckpoint: (snapshot, critical) => void trySendRuntimeMessage({ type: 'TELEMETRY_SNAPSHOT', snapshot, critical }),
    onFlush: (snapshot, reason) => void trySendRuntimeMessage({ type: 'TELEMETRY_FLUSH', snapshot, reason }),
  });
  telemetryRuns.set(runId, accumulator);
  accumulator.context('run_started');
  accumulator.checkpoint(true);
}

function disableTelemetry(): void {
  telemetryEnabled = false;
  for (const accumulator of telemetryRuns.values()) accumulator.reset();
  telemetryRuns.clear();
  telemetryDriveRuns.clear();
  activeTelemetryRunId = null;
}

// Global safety nets so failures are not swallowed by the hidden offscreen page.
window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
  const accumulator = activeTelemetryRunId ? telemetryRuns.get(activeTelemetryRunId) : undefined;
  accumulator?.context('application_error');
  accumulator?.incident({ kind: 'application_error', stage: 'offscreen_window', error: (e as any)?.error });
  accumulator?.flush('incident');
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
  const accumulator = activeTelemetryRunId ? telemetryRuns.get(activeTelemetryRunId) : undefined;
  accumulator?.incident({ kind: 'unhandled_rejection', stage: 'offscreen_promise', error: e?.reason });
  accumulator?.flush('incident');
});
L.log('script loaded');

const perfRuntimeReady = configurePerfRuntime({
  source: 'offscreen',
  sink: (entry: PerfEventEntry) => void trySendRuntimeMessage({ type: 'PERF_EVENT', entry }),
  telemetrySink: telemetryProxy,
  onSettingsChanged: (settings) => {
    debugPerf(L.log, 'runtime', 'settings_applied', {
      audioPlaybackBridgeMode: settings.audioPlaybackBridgeMode,
      adaptiveSelfVideoProfile: settings.adaptiveSelfVideoProfile,
      extendedTimeslice: settings.extendedTimeslice,
      dynamicDriveChunkSizing: settings.dynamicDriveChunkSizing,
      parallelUploadConcurrency: settings.parallelUploadConcurrency,
    });
  },
});

// ─── Runtime state ───────────────────────────────────────────────────────────

let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;

// ─── Runtime diagnostics ─────────────────────────────────────────────────────

const runtimeSampler = new RuntimeSampler(RUNTIME_SAMPLE_INTERVAL_MS, nowMs());
const productionRuntimeSampler = new RuntimeSampler(PRODUCTION_RUNTIME_SAMPLE_INTERVAL_MS, nowMs());

// Phase/warning state machine and stop→finalize coordinator. Services are
// attached below once the engine and finalizer exist.
const controller = new OffscreenController({
  postMessage: (message) => {
    const runId = activeTelemetryRunId;
    const accumulator = runId ? telemetryRuns.get(runId) : undefined;
    if (!accumulator) { getPort().postMessage(message); return; }
    if (message.phase === 'idle') {
      accumulator.context('finalize_completed');
      getPort().postMessage({ ...message, telemetrySnapshot: accumulator.snapshot() });
      if (!telemetryDriveRuns.has(runId!)) telemetryRuns.delete(runId!);
      activeTelemetryRunId = null;
    } else if (message.phase === 'failed') {
      if (accumulator.snapshot().incidents.length === 0) {
        accumulator.incident({ kind: 'recording_runtime_failed', stage: 'offscreen_phase' });
      }
      getPort().postMessage({ ...message, telemetrySnapshot: accumulator.snapshot() });
      telemetryRuns.delete(runId!);
      activeTelemetryRunId = null;
    } else {
      getPort().postMessage(message);
    }
  },
  sampler: runtimeSampler,
  error: L.error,
  now: nowMs,
  onWarning: (warning) => {
    debugPerf(L.log, 'lifecycle', 'warning', { warning });
  },
  onFinalizeFailed: (error) => {
    const accumulator = activeTelemetryRunId ? telemetryRuns.get(activeTelemetryRunId) : undefined;
    accumulator?.incident({ kind: 'recording_finalize_failed', stage: 'offscreen_phase', error });
  },
});

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const supportedEntryTypes = (PerformanceObserver as any).supportedEntryTypes as string[] | undefined;
    if (Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          runtimeSampler.recordLongTask(roundMs(entry.duration));
          productionRuntimeSampler.recordLongTask(roundMs(entry.duration));
        }
      });
      observer.observe({ entryTypes: ['longtask'] as any });
    }
  } catch {}
}

const retainedMediaStore = new RetainedMediaStore({
  getRoot: () => navigator.storage.getDirectory(),
  warn: L.warn,
});

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
    onStartRequested: (runConfig, storageMode, epoch, historyId, telemetryRunId) => {
      if (telemetryRunId) {
        if (storageMode === 'drive') telemetryDriveRuns.add(telemetryRunId);
        beginTelemetryRun(telemetryRunId);
      }
      controller.onStartRequested(runConfig, storageMode, epoch, historyId, telemetryRunId);
    },
    onStopRequested: controller.onStopRequested,
    onDiscardRequested: controller.onDiscardRequested,
    retryUpload: (jobId) => uploadManager.retry(jobId),
    openRetained: (key: string) => retainedMediaStore.read(key),
    cancelUpload: (jobId) => uploadManager.cancel(jobId),
    acknowledgeUploadState: (jobId) => uploadJobStateOutbox.remove(jobId),
    renameDriveResources: (resources) => renameDriveResources(getDriveToken, resources),
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

  portRef = port;
  port.postMessage({ type: 'OFFSCREEN_READY', version: getBuildId() });
  const warnings = controller.currentWarnings();
  port.postMessage({
    type: 'OFFSCREEN_STATE',
    phase: controller.currentPhase(),
    epoch: controller.currentEpoch(),
    ...(warnings.length ? { warnings } : {}),
  });
  L.log('READY signaled via Port');
  void replayUploadStates(port);
  return port;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

// ─── State helpers ───────────────────────────────────────────────────────────

function requestSave({ historyId, stream, kind, retainedKey, filename, startOffsetMs, deferDelivery, blobUrl, opfsFilename }: import('./offscreen/RecordingFinalizer').LocalSaveRequest) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', historyId: historyId ?? '', stream, ...(kind ? { kind } : {}), ...(retainedKey ? { retainedKey } : {}), filename, ...(startOffsetMs != null ? { startOffsetMs } : {}), ...(deferDelivery ? { deferDelivery: true } : {}), blobUrl, opfsFilename });
}

async function getDriveToken(options?: { refresh?: boolean }): Promise<string> {
  const res = await sendToBackground({ type: 'GET_DRIVE_TOKEN', refresh: options?.refresh === true });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.error}`);
  return res.token;
}

// ─── Core services ───────────────────────────────────────────────────────────

const pendingUploadStore = createChromePendingUploadStore();
const uploadJobStateOutbox = createChromeUploadJobStateOutbox();

async function reportUploadJob(job: import('./shared/recording').UploadJob, telemetryRunId?: string): Promise<void> {
  const accumulator = telemetryRunId ? telemetryRuns.get(telemetryRunId) : undefined;
  let telemetrySnapshot: import('./shared/telemetry').TelemetrySnapshot | undefined;
  if (accumulator && !telemetryUploadJobsStarted.has(job.id)) {
    telemetryUploadJobsStarted.add(job.id);
    accumulator.increment('upload.jobs');
    accumulator.measure('upload.concurrency.max', uploadManager?.activeJobs?.().length ?? 1);
    accumulator.context('upload_started');
    accumulator.checkpoint(true);
  }
  if (accumulator && job.status !== 'uploading') {
    accumulator.increment(`upload.${job.status}`);
    const duration = Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt);
    accumulator.increment('upload.job.count');
    accumulator.increment('upload.job.total_ms', duration);
    accumulator.measure('upload.job.max_ms', duration);
    accumulator.context(`upload_${job.status}`);
    if (job.status === 'partial' || job.status === 'failed') {
      accumulator.incident({ kind: job.status === 'partial' ? 'upload_partial' : 'upload_failed', stage: 'drive_upload' });
    }
    telemetrySnapshot = accumulator.snapshot();
    telemetryRuns.delete(telemetryRunId!);
    telemetryDriveRuns.delete(telemetryRunId!);
    telemetryUploadJobsStarted.delete(job.id);
  }
  if (job.status !== 'uploading') {
    try {
      await uploadJobStateOutbox.put(job);
    } catch (error) {
      L.warn('Could not persist terminal upload state for replay', job.id, describeRuntimeError(error));
    }
  }
  try {
    getPort().postMessage({ type: 'OFFSCREEN_UPLOAD_STATE', job, telemetryRunId, telemetrySnapshot });
  } catch (error) {
    // The terminal outbox remains intact and is replayed when a later port connects.
    L.warn('Could not send upload state to background', job.id, describeRuntimeError(error));
  }
}

async function replayUploadStates(port: chrome.runtime.Port): Promise<void> {
  const current = uploadManager.activeJobs();
  let terminal: import('./shared/recording').UploadJob[] = [];
  try {
    terminal = await uploadJobStateOutbox.list();
  } catch (error) {
    L.warn('Could not load terminal upload state outbox', describeRuntimeError(error));
  }
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of terminal) byId.set(job.id, job);
  for (const job of byId.values()) {
    try {
      port.postMessage({ type: 'OFFSCREEN_UPLOAD_STATE', job, telemetryRunId: uploadManager.telemetryRunId(job.id) });
    } catch {
      return;
    }
  }
}

const finalizer = new RecordingFinalizer({
  log: L.log,
  warn: L.warn,
  requestSave,
  getDriveToken,
  reportWarning: controller.reportWarning,
  pendingUploads: pendingUploadStore,
  retainedMedia: retainedMediaStore,
});

// Background Drive-upload jobs (ADR-0004): a stopped recording's upload is detached
// from the recording session and reported to the background as OFFSCREEN_UPLOAD_STATE,
// so a new recording can start while it finishes.
const uploadManager = new UploadManager({
  finalizer,
  report: reportUploadJob,
  warn: L.warn,
  // Lets a failed upload stay retryable from the library rather than from a
  // five-minute, 128 MB in-memory budget.
  readRetained: (key) => retainedMediaStore.read(key),
});

const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyPhase: controller.pushState,
  reportCaptureDevices: controller.reportCaptureDevices,
  reportWarning: controller.reportWarning,
  // Storage gave out mid-recording: route through the same finalize pipeline a
  // user/background stop uses, so the already-persisted prefix is sealed and
  // delivered (uploaded/saved) instead of the recorder running on with nothing
  // landing on disk. The user-facing warning is already emitted by the engine.
  requestProtectiveStop: (reason: string) => {
    debugPerf(L.log, 'lifecycle', 'protective_stop', { reason });
    void controller.finalize();
  },
  openTarget: async (filename: string, mimeType: string, stream) => {
    // Prefer the worker (sync-access OPFS, off the main thread). Fall back to the
    // main-thread writable, then RAM (handled by openStorageTarget) if both fail.
    // The opfsWorkerStorage flag is a kill-switch / A/B knob (default on).
    if (PERF_FLAGS.opfsWorkerStorage && !WorkerStorageTarget.unsupported) {
      try {
        return await WorkerStorageTarget.create(filename, mimeType, stream);
      } catch (e) {
        L.warn('OPFS worker target unavailable, using main-thread writable', describeRuntimeError(e));
      }
    }
    try {
      return await LocalFileTarget.create(filename, mimeType, stream);
    } catch (e) {
      L.warn('OPFS local target create failed', describeRuntimeError(e));
      throw e;
    }
  },
});

controller.attachServices(engine, finalizer, (artifacts, context) => uploadManager.enqueue(artifacts, context.historyId, context.telemetryRunId));

// Captured during synchronous module load — before any OFFSCREEN_START RPC can
// create this session's recording files — so orphan recovery can tell a stale
// file (older) from the recording about to start (newer).
const offscreenStartedAtMs = Date.now();

// Recover anything a previous crash/power-off left behind, before any new
// recording starts. Sequential so the orphan scan sees the upload-resume domain
// already resolved; gated on idle so we never touch an active recording's files.
// Fire and forget — both are no-ops when nothing is pending.
void (async () => {
  if (controller.currentPhase() !== 'idle') return;
  // Recovery persists/reads markers via chrome.storage; skip in any host that
  // lacks it (e.g. the e2e tab-capture runtime) rather than throwing.
  if (!hasLocalStorageArea()) return;
  // #1: re-upload a Drive upload interrupted mid-flight (sealed, marked files).
  try {
    await resumePendingDriveUploadsWithChrome({
      store: pendingUploadStore,
      getDriveToken,
      log: L.log,
      warn: L.warn,
      reportJob: reportUploadJob,
    });
  } catch (e) {
    L.warn('Pending Drive upload recovery failed', describeRuntimeError(e));
  }
  // #2: recover orphaned recordings — unmarked OPFS files left by a crash during
  // capture or local save — by sealing (best-effort) and downloading them. The
  // cutoff is THIS offscreen's start time: since the offscreen is created for a
  // new recording, the cutoff excludes that recording's own file (newer) so the
  // scan can never clobber an actively-writing capture.
  try {
    await recoverOrphanRecordingsWithChrome({
      cutoffMs: offscreenStartedAtMs,
      pendingUploads: pendingUploadStore,
      requestSave,
      log: L.log,
      warn: L.warn,
    });
  } catch (e) {
    L.warn('Orphan recording recovery failed', describeRuntimeError(e));
  }
})();

// ─── Runtime diagnostics sampling ─────────────────────────────────────────────

function sampleRuntimeMetrics() {
  if (controller.currentPhase() === 'idle') return;
  const now = Date.now();
  if (!isPerfDebugMode()) {
    if (!telemetryEnabled || !activeTelemetryRunId || now - lastProductionRuntimeSampleAt < PRODUCTION_RUNTIME_SAMPLE_INTERVAL_MS) return;
    lastProductionRuntimeSampleAt = now;
  }
  const diagnostics = (isPerfDebugMode() ? runtimeSampler : productionRuntimeSampler).sample(nowMs());
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
    heapBucket: perfMemory?.usedJSHeapSize == null ? undefined : Math.min(5, Math.floor(perfMemory.usedJSHeapSize / (128 * 1024 * 1024))),
    eventLoopLagMs: diagnostics.eventLoopLagMs,
    avgEventLoopLagMs: diagnostics.avgEventLoopLagMs,
    maxEventLoopLagMs: diagnostics.maxEventLoopLagMs,
    longTaskCount: diagnostics.longTaskCount,
    longTaskDurationMs: diagnostics.longTaskDurationMs,
    lastLongTaskMs: diagnostics.lastLongTaskMs,
    maxLongTaskMs: diagnostics.maxLongTaskMs,
  });
}

setInterval(sampleRuntimeMetrics, RUNTIME_SAMPLE_INTERVAL_MS);
setInterval(() => {
  if (!telemetryEnabled) return;
  for (const accumulator of telemetryRuns.values()) accumulator.checkpoint();
}, 60_000);

const telemetryPreferenceReady = loadExtensionSettingsFromStorage()
  .then((settings) => { telemetryEnabled = settings.privacy.anonymousDiagnostics; if (!telemetryEnabled) disableTelemetry(); })
  .catch(() => {});
addStorageChangedListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.extensionSettings) return;
  const enabled = normalizeExtensionSettings(changes.extensionSettings.newValue).privacy.anonymousDiagnostics;
  telemetryEnabled = enabled;
  if (!enabled) disableTelemetry();
});

void Promise.all([perfRuntimeReady, telemetryPreferenceReady])
  .catch((error) => {
    L.warn('Failed to initialize performance settings; continuing with defaults', error);
  })
  .finally(() => {
    wireRuntimeListener(connectPort);
    getPort();
  });
