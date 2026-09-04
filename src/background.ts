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

import { PlaybackLeaseManager } from './background/PlaybackLeaseManager';
import { addTabRemovedListener } from './platform/chrome/tabs';
import { fetchDriveTokenWithFallback } from './background/driveAuth';
import { DrivePlaybackAuthLeaseManager } from './background/DrivePlaybackAuthLeaseManager';
import { RecordingPlaybackService } from './background/RecordingPlaybackService';
import { reconcileRetainedMedia } from './background/RetainedMediaReconciler';
import { existsByKey, hasLibraryDirectory, listLibraryFiles, removeByKey } from './offscreen/storage/opfsLayout';
import { OffscreenManager } from './background/OffscreenManager';
import { PerfDebugStore } from './background/PerfDebugStore';
import { RecordingController } from './background/RecordingController';
import { RecordingSession } from './background/RecordingSession';
import { registerMessageHandlers } from './background/messageHandlers';
import { createChromeCpuSampler } from './background/perf/CpuSampler';
import { registerRecordingCommands } from './background/recordingCommands';
import { registerRecordingAutoStop } from './background/recordingAutoStop';
import { createPhaseWatchdog } from './background/phaseWatchdog';
import { startKeepAlive, stopKeepAlive, isFreshRecordingStart, registerSaveHandler } from './background/sessionLifecycle';
import { RecordingHistoryRepository } from './background/RecordingHistoryRepository';
import { RecordingNotationRepository } from './background/RecordingNotationRepository';
import { RecordingNotationService } from './background/RecordingNotationService';
import { RecordingHistoryService } from './background/RecordingHistoryService';
import { openDownloadedFile } from './platform/chrome/downloads';
import { hydrateLegacySession, LEGACY_SESSION_PHASE_KEY, LEGACY_SESSION_RUN_CONFIG_KEY } from './background/legacySession';
import { getSessionStorageValues, setSessionStorageValues } from './platform/chrome/storage';
import { makeLogger } from './shared/logger';
import {
  configurePerfRuntime,
  getPerfSettingsSnapshot,
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
} from './shared/perf';
import {
  hasUploadsInFlight,
  isBusyPhase,
  RECORDING_SESSION_STORAGE_KEY,
  toStatusView,
  type RecordingPhase,
} from './shared/recording';
import { TIMEOUTS } from './shared/timeouts';
import { TelemetryRuntime } from './background/TelemetryRuntime';

const L = makeLogger('background');
const offscreen = new OffscreenManager();
// Notations are their own aggregate in the same database (ADR-0005), so they
// are constructed first: history delegates its dependent cleanup to them.
const notations = new RecordingNotationService(new RecordingNotationRepository());
const historyRepository = new RecordingHistoryRepository();
const LEASE_STORAGE_KEY = 'playbackLeases';
const deleteRetainedKeys = async (keys: string[]) => {
  const root = await navigator.storage.getDirectory();
  for (const key of keys) await removeByKey(root, key);
};
const playbackLeases = new PlaybackLeaseManager({
  read: async () => (await chrome.storage.session.get(LEASE_STORAGE_KEY))?.[LEASE_STORAGE_KEY],
  write: async (state) => { await chrome.storage.session.set({ [LEASE_STORAGE_KEY]: state }); },
  deleteRetained: deleteRetainedKeys,
  warn: L.warn,
});
const history = new RecordingHistoryService(
  historyRepository,
  openDownloadedFile,
  Date.now,
  async (resources) => {
    await offscreen.ensureReady();
    return await offscreen.rpc({ type: 'OFFSCREEN_RENAME_DRIVE_RESOURCES', resources });
  },
  (id) => notations.removeAll(id),
  async (keys, historyId) => {
    // The tombstone already stands. If a player is reading these bytes, the
    // deletion waits for it rather than pulling the file out mid-frame.
    if (await playbackLeases.isLeased(historyId)) {
      await playbackLeases.defer(historyId, keys);
      return;
    }
    await deleteRetainedKeys(keys);
  },
);
const playback = new RecordingPlaybackService({
  getEntry: (id) => historyRepository.get(id),
  listNotations: (id) => notations.list(id),
});
const driveAuthLease = new DrivePlaybackAuthLeaseManager({
  // The extension's existing Drive auth, not a second OAuth system.
  getToken: async (options) => {
    const res = await fetchDriveTokenWithFallback({ refresh: options?.refresh === true });
    if (!res.ok) throw new Error(res.error);
    return res.token;
  },
  warn: L.warn,
});
const telemetry = new TelemetryRuntime();



globalThis.addEventListener?.('error', (event: ErrorEvent) => {
  telemetry.incident({ kind: 'application_error', stage: 'runtime', error: event.error });
});
globalThis.addEventListener?.('unhandledrejection', (event: PromiseRejectionEvent) => {
  telemetry.incident({ kind: 'unhandled_rejection', stage: 'runtime', error: event.reason });
});

let sessionHydrated = false;
// Tracks the prior phase so we can reset diagnostics at the START of a new
// recording (not on idle) — see isFreshRecordingStart.
let previousPhase: RecordingPhase = 'idle';
// Set when an extension update arrives mid-recording; applied once work finishes.
let pendingReload = false;

const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), L.warn);
const session = new RecordingSession(
  async (snapshot) => {
    try {
      await setSessionStorageValues({ [RECORDING_SESSION_STORAGE_KEY]: snapshot });
    } catch (error) {
      L.warn('storage.session.set failed (recording session):', error);
      // Terminal upload outbox entries may be acknowledged only after this
      // write succeeds. Re-throw so RecordingSession.flush() preserves that
      // durability boundary for persistUploadState().
      throw error;
    }
  },
  (snapshot) => {
    // Liveness backstop: (re)arm/clear the phase watchdog on every transition,
    // including the rehydrated one after a service-worker restart (ADR-0003).
    phaseWatchdog.observe(snapshot);
    // ADR-0004: keep the worker alive while a decoupled upload drains so its
    // OFFSCREEN_UPLOAD_STATE progress keeps reaching (and persisting on) the session.
    if (isBusyPhase(snapshot.phase) || hasUploadsInFlight(snapshot.uploadJobs)) {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
    offscreen.hydratePhase(snapshot.phase);
    // The manager may be recreated during a service-worker restart; treating an
    // absent hand-off as an empty seed keeps persistence authoritative until the
    // live offscreen port reconnects and replays its jobs.
    offscreen.hydrateUploadJobs?.(snapshot.uploadJobs);
    // Reset diagnostics at the start of a new recording, so a finished run's
    // diagnostics survive (idle no longer wipes them) until the next one begins.
    // Guarded by sessionHydrated so a rehydrated busy phase after a SW restart is
    // not mistaken for a fresh start.
    if (sessionHydrated && isFreshRecordingStart(previousPhase, snapshot.phase)) {
      perfDebugStore.clear();
    }
    previousPhase = snapshot.phase;
    perfDebugStore.setPhase(snapshot.phase);
    if (!isBusyPhase(snapshot.phase) && !hasUploadsInFlight(snapshot.uploadJobs) && pendingReload) {
      L.log('Applying deferred update reload now that work has finished');
      chrome.runtime.reload();
    }
    void import('./shared/messages').then(({ broadcastToPopup }) =>
      broadcastToPopup({ type: 'RECORDING_STATE', session: toStatusView(snapshot) })
    );
  },
  // A note left open when the run ends is sealed at the last recorded position
  // rather than discarded, and marked so a screen can show it ended that way
  // (ADR-0005). Best-effort: failing to seal must not disturb the transition.
  (historyId, durationMs) => {
    void notations.closeOpenSpans(historyId, durationMs)
      .catch((error) => L.warn('Could not close open notations for the finished run:', error));
  }
);

// Wire offscreen -> background save requests and session phase updates.
offscreen.onStateChanged = (msg) => {
  // Fencing token (ADR-0003): drop status from a previous run — a stale
  // OFFSCREEN_STATE that survived a port reconnect, SW restart, or offscreen
  // recreation. The current run's epoch is persisted in the session, so this stays
  // correct across restarts. Inert until the first start() (epoch undefined → idle).
  const currentEpoch = session.getSnapshot().epoch;
  if (currentEpoch != null && msg.epoch !== currentEpoch) {
    L.log(`Ignoring stale OFFSCREEN_STATE (epoch ${msg.epoch ?? 'none'} != current ${currentEpoch})`);
    return;
  }
  session.applyOffscreenPhase(msg);
  if (msg.telemetrySnapshot) {
    void telemetry.receive(msg.telemetrySnapshot, true).then(() => {
      if (msg.phase === 'idle') {
        const runId = msg.telemetrySnapshot!.runId;
        telemetry.completeRecording(runId);
        setTimeout(() => { void telemetry.flushRun(runId, 'recording_complete'); }, 250);
      }
      if (msg.phase === 'failed') {
        const runId = msg.telemetrySnapshot!.runId;
        setTimeout(() => { void telemetry.flushIncidentRun(runId); }, 0);
      }
    });
  }
};

// ADR-0004: a background upload job changed — persist it on the session (keyed by
// id, phase-independent) so the popup can render it and "busy" reflects it.
let uploadStatePersistenceTail: Promise<void> = Promise.resolve();
offscreen.onUploadJobChanged = (job, telemetryRunId, telemetrySnapshot) => {
  if (telemetryRunId) telemetry.bindUploadJob(telemetryRunId, job.id);
  const owningRunId = telemetryRunId ?? telemetry.runIdForUploadJob(job.id);
  if (job.status !== 'uploading' && owningRunId) {
    if (telemetrySnapshot) {
      void telemetry.receive(telemetrySnapshot, true)
        .then(() => telemetry.flushRun(owningRunId, 'upload_complete'))
        .catch(() => {});
    } else {
      void telemetry.recordRecoveredUploadOutcome(owningRunId, job).catch(() => {});
    }
  }
  // Preserve the order emitted by the offscreen document. In particular, the
  // initial `uploading` row must reach both durable projections before a fast
  // terminal report is allowed to acknowledge and clear its replay outbox item.
  const snapshot = structuredClone(job);
  uploadStatePersistenceTail = uploadStatePersistenceTail
    .catch(() => {})
    .then(() => persistUploadState(snapshot));
  void uploadStatePersistenceTail.catch(() => {});
};

async function persistUploadState(job: import('./shared/recording').UploadJob): Promise<void> {
  try {
    // A terminal state can trigger the popup's naming modal immediately. Persist its
    // history entry first so the rename command can never race a missing recording.
    if (job.status === 'uploading') {
      session.upsertUploadJob(job);
      await session.flush();
      await history.applyUploadJob(job);
    } else {
      await history.applyUploadJob(job);
      session.upsertUploadJob(job);
      await session.flush();
    }
    // applyUploadJob creates the row if it is absent, so the duration is stamped
    // after it. `runDurationMs` answers whether or not the session has already
    // returned to idle, so this does not depend on message ordering.
    if (job.historyId) await history.setDuration(job.historyId, session.runDurationMs(job.historyId));
    if (job.status !== 'uploading') await offscreen.acknowledgeUploadState?.(job.id);
  } catch (error) {
    // Do not acknowledge a terminal outbox item unless both persisted views are
    // durable. A reconnect will replay it and converge idempotently.
    L.warn('Could not persist upload state:', error);
  }
}

// Liveness backstop for an orphaned `starting`/`stopping` (ADR-0003). Complements
// the epoch fence: the fence drops *stale* status, this rescues *missing* status —
// a session left mid-start or mid-stop when the worker died and the offscreen is
// dead/wedged, so no RPC drives it on.
const phaseWatchdog = createPhaseWatchdog({
  budgets: {
    starting: TIMEOUTS.STARTING_WATCHDOG_MS,
    stopping: TIMEOUTS.STOPPING_WATCHDOG_MS,
  },
  getSnapshot: () => session.getSnapshot(),
  onStuck: (snapshot) => {
    // A stuck `stopping` means capture already happened — the bytes are on disk and
    // orphan-recovery downloads them on the next launch — so the message says so
    // rather than implying the recording was lost.
    const error =
      snapshot.phase === 'stopping'
        ? 'Recording stop timed out — the recorder never confirmed finalize. Any captured file is recovered on the next launch.'
        : 'Recording start timed out — the recorder never confirmed it began.';
    L.warn(`Phase watchdog: session stuck in '${snapshot.phase}'; failing it and tearing down the offscreen so a retry starts clean`);
    session.fail(error);
    // fail() flips lastKnownPhase to 'failed' (non-busy) via the change-listener
    // above, so closeForUpdate now proceeds and discards the dead/wedged/zombie
    // offscreen (otherwise a wedged one would reject the retry's OFFSCREEN_START).
    void offscreen.closeForUpdate().catch((e) => L.warn('Watchdog offscreen teardown failed (non-fatal):', e));
  },
});

registerSaveHandler(offscreen, L, history, (historyId) => session.runDurationMs(historyId));

// The recording control plane: every start/stop trigger drives this one seam.
const controller = new RecordingController({ L, offscreen, session, telemetry, notations });

// Register all popup message handlers.
registerMessageHandlers({ L, session, perfDebugStore, controller, cpuSampler: createChromeCpuSampler(), history, notations,
  playback, playbackLeases, driveAuthLease, telemetry });
registerRecordingCommands({ L, controller });
registerRecordingAutoStop({ session, controller });

// A closed tab must not leave a live credential attached to an id Chrome can
// recycle (ADR-0006 §15). Registered after recordingAutoStop so a closing
// recorded tab still stops its recording first.
addTabRemovedListener((tabId) => {
  void driveAuthLease.releaseTab(tabId).catch((error) => L.warn('Drive lease release failed:', error));
  // Releasing the last reader is what finally frees a deleted recording's bytes.
  void playbackLeases.releaseTab(tabId)
    .then((freed) => { if (freed) L.log(`Freed retained media for ${freed} deleted recording(s)`); })
    .catch((error) => L.warn('Playback lease release failed:', error));
});

// Register port listeners for offscreen and debug dashboard connections.
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name === 'offscreen') {
    offscreen.attachPort(port);
  }
});

// Register suspend handler for graceful stop on service-worker sleep.
chrome.runtime.onSuspend?.addListener(async () => {
  await offscreen.stopIfPossibleOnSuspend();
});

// Apply downloaded updates promptly, without interrupting an active recording.
chrome.runtime.onUpdateAvailable?.addListener(() => {
  void sessionHydration.then(() => {
    const snapshot = session.getSnapshot();
    if (!isBusyPhase(snapshot.phase) && !hasUploadsInFlight(snapshot.uploadJobs)) {
      L.log('Update available; reloading to apply');
      chrome.runtime.reload();
    } else {
      L.log('Update available; deferring reload until current work finishes');
      pendingReload = true;
    }
  });
});

// On update, discard any stale offscreen document so the next recording runs new code.
// If work is in flight, defer to a reload after it finishes rather than tearing it down.
chrome.runtime.onInstalled?.addListener(async (details) => {
  if (details.reason !== 'update') return;
  await sessionHydration;
  L.log('Extension updated; refreshing offscreen document');
  const closed = await offscreen.closeForUpdate();
  if (!closed) pendingReload = true;
});

// Hydrate persisted session on service-worker (re)start.
const sessionHydration = (async () => {
  try {
    const settings = await configurePerfRuntime({
      source: 'background',
      sink: (entry) => perfDebugStore.record(entry),
      telemetrySink: {
        increment: (...args) => telemetry.sink()?.increment(...args),
        measure: (...args) => telemetry.sink()?.measure(...args),
        context: (...args) => telemetry.sink()?.context(...args),
        incident: (...args) => telemetry.sink()?.incident(...args),
        checkpoint: (...args) => telemetry.sink()?.checkpoint(...args),
        flush: (...args) => telemetry.sink()?.flush(...args),
      },
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
    try {
      await telemetry.initialize(
        isBusyPhase(snapshot.phase) && snapshot.epoch != null ? new Set([snapshot.epoch]) : new Set(),
        new Set(snapshot.uploadJobs?.filter((job) => job.status === 'uploading').map((job) => job.id) ?? [])
      );
    } catch (error) {
      L.warn('Anonymous telemetry initialization failed (non-fatal):', error);
      telemetry.setEnabled(false);
    }
    if (isBusyPhase(snapshot.phase) || hasUploadsInFlight(snapshot.uploadJobs)) {
      L.log('SW restarted while offscreen work was active — re-attaching offscreen');
      await offscreen.ensureReady();
      startKeepAlive();
    }
  } catch (e) {
    L.warn('Session re-hydration failed (non-fatal):', e);
  } finally {
    sessionHydrated = true;
  }

  // Converge library/ and history after a crash (ADR-0006). Background reads
  // OPFS here only to list and delete — it never reads media bytes, which stay
  // the browser's job to move. Strictly best-effort: a failure must not keep
  // the worker from serving recording commands.
  try {
    // Once per browser session, not once per service-worker wake: an MV3 worker
    // is evicted and restarted constantly, and this pass is startup work, not
    // per-event work. `chrome.storage.session` outlives the worker and dies with
    // the browser, which is exactly the lifetime wanted here.
    const RECONCILED_KEY = 'retainedMediaReconciled';
    const already = await chrome.storage.session.get(RECONCILED_KEY).catch(() => ({} as Record<string, unknown>));
    if ((already as Record<string, unknown>)[RECONCILED_KEY]) return;
    await chrome.storage.session.set({ [RECONCILED_KEY]: true }).catch(() => {});

    const report = await reconcileRetainedMedia({
      hasRetainedLibrary: async () => hasLibraryDirectory(await navigator.storage.getDirectory()),
      listRetained: async () => listLibraryFiles(await navigator.storage.getDirectory()),
      getEntry: (id) => historyRepository.get(id),
      listLiveEntries: () => history.list(),
      exists: async (key) => existsByKey(await navigator.storage.getDirectory(), key),
      removeRetained: async (key) => removeByKey(await navigator.storage.getDirectory(), key),
      recordLocation: (historyId, fileId, key, retainedAt) =>
        history.recordArtifactLocation(historyId, fileId, { kind: 'opfs', key, retainedAt }),
      dropLocation: (historyId, fileId, key) => history.dropArtifactLocation(historyId, fileId, key),
      log: L.log,
      warn: L.warn,
    });
    if (report.repaired || report.collected || report.staleLocations) {
      L.log('Retained-media reconciliation:', report);
    }
  } catch (e) {
    L.warn('Retained-media reconciliation failed (non-fatal):', e);
  }

  // Session state outlives the worker; the tabs it names may not.
  try {
    const tabs = await chrome.tabs.query({});
    const liveTabIds = tabs.map((tab) => tab.id).filter((id): id is number => id != null);
    const dropped = await driveAuthLease.reconcile(liveTabIds);
    if (dropped) L.log(`Dropped ${dropped} orphaned Drive playback rule(s)`);
    const freed = await playbackLeases.reconcile(liveTabIds);
    if (freed) L.log(`Freed retained media for ${freed} recording(s) whose player is gone`);
  } catch (e) {
    L.warn('Playback lease reconciliation failed (non-fatal):', e);
  }
})();
