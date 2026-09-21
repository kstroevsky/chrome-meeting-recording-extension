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

import { DriveDestinationFiler } from './background/drive/DriveDestinationFiler';
import { loadExtensionSettingsFromStorage, toStorageMode } from './shared/settings';
import { DRIVE_DEFAULT_DESTINATION_NAME } from './shared/settings';
import { DriveRootFolder } from './background/drive/DriveRootFolder';
import { DriveArtifactResolver } from './background/drive/DriveArtifactResolver';
import { PlaybackLeaseManager } from './background/playback/PlaybackLeaseManager';
import { addTabRemovedListener, sendTabMessage } from './platform/chrome/tabs';
import { fetchDriveTokenWithFallback } from './background/drive/driveAuth';
import { DrivePlaybackAuthLeaseManager } from './background/playback/DrivePlaybackAuthLeaseManager';
import { RecordingPlaybackService } from './background/playback/RecordingPlaybackService';
import { reconcileRetainedMedia } from './background/retention/RetainedMediaReconciler';
import { existsByKey, hasLibraryDirectory, listLibraryFiles, removeByKey } from './offscreen/storage/opfsLayout';
import { OffscreenManager } from './background/offscreen/OffscreenManager';
import { PerfDebugStore } from './background/observability/perf/PerfDebugStore';
import { RecordingController } from './background/recording/RecordingController';
import { RecordingSession } from './background/recording/session/RecordingSession';
import { registerMessageHandlers } from './background/messaging/messageHandlers';
import { createChromeCpuSampler } from './background/observability/perf/CpuSampler';
import { registerRecordingCommands } from './background/recording/recordingCommands';
import { registerRecordingAutoStop } from './background/recording/recordingAutoStop';
import { createPhaseWatchdog } from './background/recording/phaseWatchdog';
import { registerSaveHandler } from './background/library/history/LocalDeliveryRuntime';
import { isFreshRecordingStart, startKeepAlive, stopKeepAlive } from './background/runtime/KeepAlive';
import {
  pendingLocalDeliveries,
  type RecordingHistoryCursor,
  type RecordingHistoryEntry,
} from './shared/recordingHistory';
import { ensurePersistentStorage, readStorageUsage } from './background/retention/storageDurability';
import { broadcastToPopup } from './shared/messages';
import { RecordingHistoryRepository } from './background/library/history/RecordingHistoryRepository';
import { RecordingNotationRepository } from './background/library/notations/RecordingNotationRepository';
import { RecordingNotationService } from './background/library/notations/RecordingNotationService';
import { RecordingTranscriptRepository } from './background/library/transcript/RecordingTranscriptRepository';
import { RecordingTranscriptService } from './background/library/transcript/RecordingTranscriptService';
import { RecordingTranscriptCapture } from './background/library/transcript/RecordingTranscriptCapture';
import { RecordingAnalysisRepository } from './background/library/analysis/RecordingAnalysisRepository';
import { RecordingAnalysisService } from './background/library/analysis/RecordingAnalysisService';
import { RecordingAnalysisCoordinator } from './background/library/analysis/RecordingAnalysisCoordinator';
import { CANDIDATE_ANALYSIS_CONFIG } from './shared/analysis/candidateConfig';
import { hashAnalysisConfig, PIPELINE_VERSION } from './shared/analysis/provenance';
import { packagedModel } from './shared/analysis/packagedModel';
import { RecordingHistoryService } from './background/library/history/RecordingHistoryService';
import { openDownloadedFile } from './platform/chrome/downloads';
import { hydrateLegacySession, LEGACY_SESSION_PHASE_KEY, LEGACY_SESSION_RUN_CONFIG_KEY } from './background/recording/session/legacySession';
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
import { TelemetryRuntime } from './background/observability/telemetry/TelemetryRuntime';
import {
  captureMayBeUnsaved,
  markCaptureSettled,
  noteCaptureProgress,
  recordedCaptureDurationMs,
} from './background/recording/unsavedCaptureFlag';
import type { UnsavedRecording } from './offscreen/storage/recoverOrphanRecordings';
import { plannedFolderRenames } from './background/drive/driveFolderNameRepair';

const L = makeLogger('background');
const offscreen = new OffscreenManager();
// Notations are their own aggregate in the same database (ADR-0005), so they
// are constructed first: history delegates its dependent cleanup to them.
const notations = new RecordingNotationService(new RecordingNotationRepository());
const transcripts = new RecordingTranscriptService(new RecordingTranscriptRepository());
// Topic analysis (ADR-0007). Provenance is assembled here, from the model the
// build actually packaged and the configuration a fresh run would use, so a
// stored result produced under different conditions reads as stale (D-14).
const analyses = new RecordingAnalysisService(new RecordingAnalysisRepository(), () => {
  const model = packagedModel();
  return {
    pipelineVersion: PIPELINE_VERSION,
    embeddingModel: model.id,
    embeddingModelRevision: model.revision,
    // EMB-03. Recorded rather than asked of the worker, which may not be running.
    embeddingDimensions: 384,
    embeddingDtype: model.dtype,
    configHash: hashAnalysisConfig(CANDIDATE_ANALYSIS_CONFIG),
  };
});
const analysisCoordinator = new RecordingAnalysisCoordinator({
  dataPlane: offscreen,
  analyses,
  readTranscript: (historyId) => transcripts.get(historyId),
  // The tombstone `RecordingHistoryService.remove` writes before any dependent
  // cleanup — durable, so it still fences a late result after this worker is
  // gone. An absent row is deliberately *not* deleted: see the dep's docs.
  isRecordingDeleted: async (historyId) => Boolean((await historyRepository.get(historyId))?.deletedAt),
  config: () => CANDIDATE_ANALYSIS_CONFIG,
  // Analysis settling is invisible to `RecordingSession`, so a deferred reload
  // waiting on "work finished" has to be told here.
  onSettled: () => syncCriticalWork(),
});
offscreen.onAnalysisJobChanged = (job) => {
  // The data plane is reachable and reporting, so its state is no longer unknown.
  clearAnalysisWorkUnknown();
  analysisCoordinator.handleJobState(job);
  // A job starting needs keep-alive; one ending without a result has just been
  // acknowledged and may have been the last thing holding a reload back.
  syncCriticalWork();
};
offscreen.onAnalysisResult = (job, analysis, provenance) => {
  void analysisCoordinator.handleResult(job, analysis, provenance)
    .catch((error) => L.warn('Could not handle an analysis result', job.historyId, error))
    // Persisting and acknowledging a result is the moment analysis stops being
    // critical work, and nothing in the session will notice it.
    .finally(() => syncCriticalWork());
};
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
  async (id) => {
    // Every derived aggregate goes with the recording it describes.
    await notations.removeAll(id);
    await transcripts.removeAll(id).catch((error) => L.warn('Could not remove recording transcript:', error));
    // Analyses are the largest rows this database holds — megabytes of vectors
    // per recording — so leaving them behind is a storage leak that grows with
    // every deletion. `purge` also cancels a run still in flight and refuses
    // the result if one arrives afterwards; without that, an analysis that
    // completes just after its recording is deleted writes a row nothing will
    // ever delete.
    await analysisCoordinator.purge(id).catch((error) => L.warn('Could not remove recording analysis:', error));
  },
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
  transcriptStatus: (id) => transcripts.status(id),
  // `get` returns nothing for a stale result as well as an absent one, which is
  // what the player wants: topics from another configuration are not topics.
  analysis: (id) => analyses.get(id),
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
/** One authenticated Drive call, shared by metadata and folder listing. */
const driveJson = async (url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const res = await fetchDriveTokenWithFallback();
  if (!res.ok) throw new Error(res.error);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${res.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
};
const driveArtifacts = new DriveArtifactResolver({
  getMetadata: async (fileId) => {
    const { status, body } = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,trashed`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`Drive metadata ${status}`);
    return body;
  },
  listFolder: async (folderId) => {
    // Quoted ids are safe here: a Drive id is [A-Za-z0-9_-] only.
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const { status, body } = await driveJson(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size,trashed)&pageSize=200`);
    if (status !== 200) throw new Error(`Drive folder listing ${status}`);
    return body?.files ?? [];
  },
  warn: L.warn,
});
/**
 * The Drive folder operations this extension performs, in one place: the filer
 * moves a recording between destinations, the renamer renames the root. Shared
 * so both speak to Drive the same way.
 */
const driveFolderPorts = {
  getFolder: async (id: string) => {
    const { status, body } = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,parents`);
    return status === 200 ? body : null;
  },
  findFolder: async (name: string, parentId: string | null) => {
    const query = encodeURIComponent(
      `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`
      + ` and '${(parentId ?? 'root').replace(/'/g, "\\'")}' in parents and trashed = false`);
    const { status, body } = await driveJson(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,parents)&pageSize=1`);
    return status === 200 ? (body?.files?.[0] ?? null) : null;
  },
  createFolder: async (name: string, parentId: string | null) => {
    const { status, body } = await driveJson('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    if (status !== 200) throw new Error(`Could not create the destination folder (${status})`);
    return body;
  },
  renameFolder: async (folderId: string, name: string) => {
    const { status } = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name`,
      { method: 'PATCH', body: JSON.stringify({ name }) });
    if (status !== 200) throw new Error(`Could not rename the folder in Google Drive (${status})`);
  },
  moveFolder: async (folderId: string, addParent: string, removeParents: string[]) => {
    const params = new URLSearchParams({ addParents: addParent, fields: 'id,parents' });
    if (removeParents.length) params.set('removeParents', removeParents.join(','));
    const { status } = await driveJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${params}`,
      { method: 'PATCH', body: '{}' });
    if (status !== 200) throw new Error(`Could not move the recording folder (${status})`);
  },
  warn: L.warn,
};
const driveFolders = new DriveDestinationFiler(driveFolderPorts);

/**
 * Files a recording under a destination, or unfiles it back to the default one.
 * Drive first, history second: a history row claiming a destination the move
 * never reached would be a lie.
 */
const fileRecordingToDestination = async (recordingId: string, presetId: string | null) => {
  const entry = await historyRepository.get(recordingId);
  if (!entry || entry.deletedAt) throw new Error('This recording is no longer available');
  if (!entry.driveFolderId) throw new Error('This recording has no Google Drive folder to move');

  const settings = await loadExtensionSettingsFromStorage();
  const preset = presetId
    ? settings.storage.driveFolderPresets.find((candidate) => candidate.id === presetId)
    : undefined;
  if (presetId && !preset) throw new Error('That destination no longer exists');

  const result = await driveFolders.file(
    entry.driveFolderId,
    preset?.name ?? DRIVE_DEFAULT_DESTINATION_NAME,
    settings.storage.driveRootFolderName,
  );
  if (result.status === 'missing') throw new Error('This recording\u2019s folder is no longer in Google Drive');
  await history.setDriveDestination(recordingId, presetId);
  // Filing proves there is a working token, which the update-time attempt may
  // not have had. Deliberately not awaited: tidying old folders must never
  // delay, or fail, the filing the user actually asked for.
  void tidyDriveOnce();
};

/**
 * Renaming in Settings renames in Drive, because folders are resolved by name:
 * a setting that disagrees with Drive would send the next upload to a second
 * folder and leave the earlier recordings somewhere nothing looks.
 */
const driveRootFolder = new DriveRootFolder(driveFolderPorts);

/**
 * Pulls destinations made before destinations were nested — they were created
 * at the top of My Drive — back inside the root folder. Driven from history so
 * only folders that actually hold recordings are touched.
 *
 * A migration, not a feature: it runs itself, once, and then never again. There
 * is nothing to operate, because a recording's folder being in the right place
 * is not a thing anyone should have to ask for.
 */
const DRIVE_DESTINATIONS_GATHERED_KEY = 'driveDestinationsGathered';

const gatherDriveDestinations = async () => {
  const settings = await loadExtensionSettingsFromStorage();
  // Paged through rather than read as one list: a destination folder is only
  // discoverable through the recordings inside it, and history can be long.
  const folderIds = new Set<string>();
  let cursor: RecordingHistoryCursor | undefined;
  do {
    const page = await historyRepository.listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const entry of page.entries) {
      if (!entry.deletedAt && entry.driveFolderId) folderIds.add(entry.driveFolderId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const recordingFolderIds = [...folderIds];
  return await driveRootFolder.gather(
    recordingFolderIds,
    settings.storage.driveFolderPresets.map((preset) => preset.name),
    settings.storage.driveRootFolderName,
  );
};

/**
 * What a crash left behind (8D).
 *
 * The flag is checked first and the offscreen document is only created when it
 * is set: the scan is cheap, but reaching it is not, and the popup asks this on
 * every open. A clean run clears the flag, so the usual answer costs one
 * storage read.
 */
const listUnsavedRecordings = async () => {
  if (!await captureMayBeUnsaved()) return [];
  // A capture in flight owns staging; asking mid-run would describe the file
  // being written as though it were abandoned.
  if (session.getSnapshot().phase !== 'idle') return [];
  try {
    await offscreen.ensureReady();
    const response = await offscreen.rpc<{ ok: boolean; recordings?: UnsavedRecording[] }>({ type: 'OFFSCREEN_LIST_UNSAVED' });
    const found = response?.recordings ?? [];
    // The run's own clock beats the estimate the filename allows: it excludes
    // paused spans, and it was measured rather than inferred.
    const recordings = await Promise.all(found.map(async (recording) => {
      const recorded = await recordedCaptureDurationMs(recording.lastModifiedMs);
      return recorded != null ? { ...recording, approxDurationMs: recorded } : recording;
    }));
    // Nothing there means the flag was set by a run that finished after all —
    // a worker death after delivery, say — so stop asking.
    if (!recordings.length) await markCaptureSettled();
    return recordings;
  } catch (error) {
    L.warn('Could not look for unsaved recordings:', error);
    return [];
  }
};

/**
 * Acts on one, once the user has decided. The storage mode is read here rather
 * than sent from the popup: it is where this recording would have gone had it
 * finished, and that is settings' answer to give, not the dialog's.
 */
const resolveUnsavedRecording = async (key: string, action: 'save' | 'discard', name?: string) => {
  const settings = await loadExtensionSettingsFromStorage();
  await offscreen.ensureReady();
  const response = await offscreen.rpc<{ ok: boolean; error?: string }>({
    type: 'OFFSCREEN_RESOLVE_UNSAVED',
    key,
    action,
    ...(name ? { name } : {}),
    storageMode: toStorageMode(settings.basic.recordingMode),
  });
  if (!response?.ok) throw new Error(response?.error || 'Could not save that recording');
  // Decided either way, so it is no longer unaccounted for.
  await markCaptureSettled();
};

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

/**
 * Work an extension reload would destroy, in one place.
 *
 * Three kinds, each of which lives partly or wholly in the offscreen document
 * and dies with it: a capture, a detached upload (ADR-0004), and a topic
 * analysis — including one that has **finished computing but not yet been
 * acknowledged**, whose only copy is in offscreen memory (ADR-0007, HOST-04).
 *
 * Every decision that could tear the runtime down — applying an update,
 * deferring one, keeping the worker alive — reads this rather than restating
 * the list, because the previous restatements were how analysis got left out.
 */
function hasCriticalWork(snapshot = session.getSnapshot()): boolean {
  return isBusyPhase(snapshot.phase)
    || hasUploadsInFlight(snapshot.uploadJobs)
    || offscreen.hasActiveAnalysisJobs()
    // Not knowing whether an analysis is running means treating one as running.
    || analysisWorkUnknown;
}

/**
 * True when the data plane could not be asked what it is doing.
 *
 * Deferring a reload on "we could not ask" is only honest if the unknown state
 * is *also* treated as busy. Otherwise the keep-alive stays off, Chrome unloads
 * an idle service worker, and it installs the pending update itself — the exact
 * outcome the deferral was protecting against.
 *
 * Cleared as soon as the data plane answers, by a direct query or by any job
 * state it reports, so an unreachable moment cannot block updates for good.
 */
let analysisWorkUnknown = false;
let analysisWorkRetry: ReturnType<typeof setTimeout> | null = null;

/** Retry cadence for a data plane that would not answer. Slow: this only has to
 *  outlast a reconnect, and a pending update is not urgent. */
const ANALYSIS_WORK_RETRY_MS = 30_000;

/** Asks the data plane what analysis work exists, and records not knowing. */
async function confirmAnalysisWork(): Promise<void> {
  try {
    await offscreen.refreshAnalysisWork();
    clearAnalysisWorkUnknown();
  } catch (error) {
    analysisWorkUnknown = true;
    L.warn('Could not confirm what the data plane is analysing; treating it as busy', error);
    if (!analysisWorkRetry) {
      analysisWorkRetry = setTimeout(() => {
        analysisWorkRetry = null;
        void confirmAnalysisWork().then(() => syncCriticalWork());
      }, ANALYSIS_WORK_RETRY_MS);
    }
  }
}

/** The data plane has spoken, by whatever route; its state is known again. */
function clearAnalysisWorkUnknown(): void {
  if (!analysisWorkUnknown) return;
  analysisWorkUnknown = false;
  if (analysisWorkRetry) {
    clearTimeout(analysisWorkRetry);
    analysisWorkRetry = null;
  }
}

/**
 * Re-evaluates the worker's lifetime after any change to critical work.
 *
 * Keep-alive matters for analysis as much as for uploads, and not only for
 * progress: Chrome installs a pending update by itself when the service worker
 * unloads, which would take the offscreen document — and a held analysis —
 * with it. A worker kept alive is a worker whose update we still control.
 *
 * Called from the session observer *and* from analysis transitions, because an
 * analysis finishing changes nothing in `RecordingSession`: a deferred reload
 * waiting only on the session would never fire once analysis was the last
 * thing holding it back.
 */
function syncCriticalWork(snapshot = session.getSnapshot()): void {
  if (hasCriticalWork(snapshot)) {
    startKeepAlive();
    return;
  }
  stopKeepAlive();
  if (pendingReload) {
    // Consumed, not merely read: several things settle at once — a job state, a
    // coordinator acknowledgement, a session transition — and a reload that is
    // already under way must not be requested again by the next one.
    pendingReload = false;
    L.log('Applying deferred update reload now that work has finished');
    chrome.runtime.reload();
  }
}

const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), L.warn);
const transcriptCapture = new RecordingTranscriptCapture({
  transcripts,
  activeHistoryId: () => session.getSnapshot().historyId,
  activeRunId: () => session.getSnapshot().epoch,
  recordedRangeAt: (startWallMs, endWallMs) => session.recordedRangeAt(startWallMs, endWallMs),
  sendToTab: (tabId, message) => sendTabMessage(tabId, message),
  warn: L.warn,
});

const session = new RecordingSession(
  async (snapshot) => {
    // The run's clock, mirrored where a browser restart cannot clear it. The
    // snapshot below goes to storage.session, which is exactly what a crash
    // takes with it — and its elapsed time is what says "~32m" rather than
    // nothing when the recording is offered back (8D).
    if (snapshot.phase === 'recording' || snapshot.phase === 'stopping') {
      void noteCaptureProgress({
        recordedMs: snapshot.recordedMs ?? 0,
        runningSince: snapshot.paused === true ? null : snapshot.runningSince ?? null,
      });
    }
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
      // Ask the meeting tab to start shipping committed captions. Best-effort:
      // a captured tab with no content script is the ordinary non-Meet case.
      if (snapshot.targetTabId != null && snapshot.epoch != null) {
        void transcriptCapture.arm(snapshot.targetTabId, snapshot.epoch);
      }
    }
    previousPhase = snapshot.phase;
    perfDebugStore.setPhase(snapshot.phase);
    // ADR-0004 and ADR-0007: keep-alive and any deferred reload both follow
    // the one definition of critical work. Evaluated after the upload hand-off
    // above so upload liveness is current when it is read.
    syncCriticalWork(snapshot);
    broadcastToPopup({ type: 'RECORDING_STATE', session: toStatusView(snapshot) });
  },
  // A note left open when the run ends is sealed at the last recorded position
  // rather than discarded, and marked so a screen can show it ended that way
  // (ADR-0005). Best-effort: failing to seal must not disturb the transition.
  (historyId, durationMs, ending) => {
    if (ending === 'discarded') {
      // Nothing about a discarded run is kept, so nothing is swept or analysed
      // for it — the discard path removes its notes and transcript itself, and
      // a sweep or an analysis racing that removal would re-create them.
      void transcriptCapture.abandon()
        .catch((error) => L.warn('Could not disarm transcript capture for the discarded run:', error));
      return;
    }
    void notations.closeOpenSpans(historyId, durationMs)
      .catch((error) => L.warn('Could not close open notations for the finished run:', error));
    // Sweep whatever the meeting tab still holds while it is reachable, then
    // stop it pushing. Best-effort for the same reason.
    void transcriptCapture.finish(historyId)
      // Analysis runs over the *finished* transcript (D-01), so it is queued
      // after the final sweep rather than beside it — starting earlier would
      // analyse a transcript missing its last minutes. Best-effort like the
      // rest of this transition: a recording whose analysis never starts is
      // still a complete recording, and the surface offers a re-run.
      .then(() => analysisCoordinator.analyze(historyId))
      .then((started) => {
        if (!started.ok && started.reason !== 'no-transcript') {
          L.warn(`Topic analysis did not start for ${historyId}: ${started.reason}`, started.error ?? '');
        }
      })
      .catch((error) => L.warn('Could not finish transcript capture for the run:', error));
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
  // Idle means every artifact of that run is delivered, downloaded, or handed
  // to an upload job with its own recovery marker — so nothing is unaccounted
  // for, and the next popup open need not go looking.
  if (msg.phase === 'idle') void markCaptureSettled();
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

const { deliverDeferred } = registerSaveHandler(
  offscreen, L, history,
  (historyId) => session.runDurationMs(historyId),
  async () => {
    try {
      return (await loadExtensionSettingsFromStorage()).storage.localFolderPresets.length;
    } catch {
      return 0;
    }
  },
  () => { void scheduleAbandonedDeliverySweep(); },
);

/**
 * How long a folder prompt may go unanswered before the recording is written to
 * the download directory anyway.
 *
 * A prompt can be abandoned in a way nothing else notices: the popup was open
 * when we asked, so we deferred, and then it closed without answering. No
 * further broadcast is coming, and the startup reconciler runs once per browser
 * session — so without this the file would wait for a browser restart. Chrome
 * clamps sub-minute alarms, so the real delay is about a minute; that is a wait,
 * not a loss, and answering the prompt is always faster.
 */
const ABANDONED_DELIVERY_ALARM = 'local-delivery-timeout';

const scheduleAbandonedDeliverySweep = async (): Promise<void> => {
  try {
    await chrome.alarms?.create?.(ABANDONED_DELIVERY_ALARM, { delayInMinutes: 0.5 });
  } catch (error) {
    L.warn('Could not schedule the local delivery sweep:', error);
  }
};

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === ABANDONED_DELIVERY_ALARM) void deliverAbandonedLocalRecordings();
});

/** Entries whose bytes are in the library but not yet written to Downloads. */
const listPendingLocalDeliveries = async (): Promise<{ id: string; name: string }[]> => {
  // Paged to exhaustion: this is reconciliation, and a recording past an
  // arbitrary cut-off would simply never be written.
  const pending: { id: string; name: string }[] = [];
  let cursor: RecordingHistoryCursor | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await historyRepository.listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const entry of result.entries) {
      if (pendingLocalDeliveries(entry).length > 0) pending.push({ id: entry.id, name: entry.name });
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return pending;
};

const deliverLocalRecording = async (recordingId: string, folderId: string | null): Promise<void> => {
  const entry = await historyRepository.get(recordingId);
  if (!entry || entry.deletedAt) throw new Error('This recording is no longer available');
  let folder: string | undefined;
  if (folderId) {
    const settings = await loadExtensionSettingsFromStorage();
    folder = settings.storage.localFolderPresets.find((preset) => preset.id === folderId)?.name;
    if (!folder) throw new Error('That folder no longer exists');
  }
  const outcomes = await deliverDeferred(entry, folder);
  // Stamped only when every file actually completed. A failed, interrupted or
  // still-unsettled download would otherwise leave history claiming a folder
  // that has nothing in it — and the label is not something the user can check
  // against the file, because we do not show them the path.
  const allLanded = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'complete');
  if (allLanded) await history.setLocalFolder(recordingId, folder);
  else if (outcomes.some((outcome) => outcome.status !== 'complete')) {
    L.warn(`Local delivery for ${recordingId} did not fully complete:`,
      outcomes.map((outcome) => outcome.status).join(', '));
  }
};

/**
 * Anything still owed to the download directory is written on startup, with no
 * folder. A prompt the user never answered must cost them a delay, not a file.
 */
const deliverAbandonedLocalRecordings = async (): Promise<void> => {
  try {
    for (const pending of await listPendingLocalDeliveries()) {
      const entry = await historyRepository.get(pending.id);
      if (entry) await deliverDeferred(entry);
    }
  } catch (error) {
    L.warn('Reconciling deferred local deliveries failed:', error);
  }
};

// The recording control plane: every start/stop trigger drives this one seam.
const controller = new RecordingController({ L, offscreen, session, telemetry, notations, transcripts, transcriptCapture });

// Register all popup message handlers.
registerMessageHandlers({ L, session, perfDebugStore, controller, cpuSampler: createChromeCpuSampler(), history, notations,
  transcripts, analyses, transcriptCapture,
  playback, playbackLeases, driveArtifacts, fileToDestination: fileRecordingToDestination,
  renameDriveRootFolder: (from, to) => driveRootFolder.rename(from, to),
  listUnsavedRecordings,
  resolveUnsavedRecording,
  listPendingLocal: listPendingLocalDeliveries, deliverLocal: deliverLocalRecording,
  storageUsage: () => readStorageUsage(async () => {
    const files = await listLibraryFiles(await navigator.storage.getDirectory());
    return files.reduce((total, file) => total + file.sizeBytes, 0);
  }),
  driveAuthLease, telemetry });
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
  void sessionHydration.then(async () => {
    if (hasCriticalWork()) {
      L.log('Update available; deferring reload until current work finishes');
      pendingReload = true;
      syncCriticalWork();
      return;
    }
    // Idle as far as this worker knows — but its view of analysis is memory,
    // empty after a restart until the offscreen document reconnects and
    // replays. Asking the data plane directly closes that window: an update
    // arriving seconds after a worker restart must not reload over an analysis
    // nobody has re-announced yet.
    // Records "unknown" as busy when it cannot be answered, so the deferral
    // below is backed by a keep-alive rather than by hope.
    await confirmAnalysisWork();
    if (hasCriticalWork()) {
      L.log('Update available; deferring reload until the running analysis finishes');
      pendingReload = true;
      syncCriticalWork();
      return;
    }
    L.log('Update available; reloading to apply');
    chrome.runtime.reload();
  });
});

// On update, discard any stale offscreen document so the next recording runs new code.
// If work is in flight, defer to a reload after it finishes rather than tearing it down.
/**
 * Puts right the folders named after the moment of upload rather than the
 * meeting, from when the filename pattern and the filename builder disagreed.
 *
 * A rename keeps the folder id, so every stored link and file id survives it,
 * and no bytes move. What it will touch is decided by `plannedFolderRenames`,
 * which is pure and tested — this half only talks to Drive and to history.
 */
const repairDriveFolderNames = async (): Promise<{ repaired: number; failed: number }> => {
  const entries: RecordingHistoryEntry[] = [];
  let cursor: RecordingHistoryCursor | undefined;
  do {
    const page = await historyRepository.listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);

  let repaired = 0;
  let failed = 0;
  for (const rename of plannedFolderRenames(entries)) {
    try {
      await driveFolderPorts.renameFolder(rename.folderId, rename.to);
      // History second: a row claiming a name Drive never took would be a lie,
      // and the next run would think there was nothing left to repair.
      await historyRepository.update(rename.historyId, (current) => (
        current ? { ...current, driveFolderName: rename.to } : current
      ));
      repaired += 1;
    } catch (error) {
      L.warn('Could not rename a recording folder in Google Drive:', error);
      failed += 1;
    }
  }
  if (repaired) L.log(`Renamed ${repaired} recording folder(s) after the meeting they hold`);
  return { repaired, failed };
};

/**
 * The one-time tidy: destinations pulled back inside the root, and folders
 * renamed after the meeting they hold rather than the moment they were
 * uploaded. Run at most once, and counted done only when Drive actually
 * answered — a run that failed for want of a token has tidied nothing, so
 * recording it as done would strand what it was meant to put right.
 */
const tidyDriveOnce = async () => {
  try {
    const stored = await chrome.storage?.local?.get?.(DRIVE_DESTINATIONS_GATHERED_KEY);
    if (stored?.[DRIVE_DESTINATIONS_GATHERED_KEY]) return;
    const result = await gatherDriveDestinations();
    const repair = await repairDriveFolderNames();
    if (result.failed > 0 || repair.failed > 0) return;
    if (result.moved.length) L.log('Moved destination folders into the recordings folder:', result.moved.join(', '));
    await chrome.storage?.local?.set?.({ [DRIVE_DESTINATIONS_GATHERED_KEY]: true });
  } catch (error) {
    // Nothing was reorganised, so the next attempt can simply try again.
    L.warn('Could not tidy the Drive destination folders:', error);
  }
};

chrome.runtime.onInstalled?.addListener(async (details) => {
  if (details.reason !== 'update') return;
  await sessionHydration;
  L.log('Extension updated; refreshing offscreen document');
  void tidyDriveOnce();
  const closed = await offscreen.closeForUpdate();
  if (!closed) pendingReload = true;
});

/**
 * The bootstrap: settings, perf runtime, telemetry and the persisted session,
 * hydrated on every service-worker start.
 *
 * Exported so an integration test can *await* it rather than guess at how many
 * macrotask turns it needs. The guess was a race — under load the bootstrap
 * outran a fixed drain, and work that finished after teardown failed the run
 * with every assertion passing. Nothing in production reads this export;
 * `background.js` is a bundled entry point.
 */
// Hydrate persisted session on service-worker (re)start.
export const sessionHydration = (async () => {
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
    } else {
      // An analysis the previous worker instance was waiting on. Reconnecting
      // now, rather than on the offscreen document's own backoff (up to 30 s),
      // is what gets a held result persisted promptly.
      await confirmAnalysisWork();
      if (hasCriticalWork()) {
        L.log('SW restarted while an analysis was active — re-attaching offscreen');
        syncCriticalWork();
      }
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

  // Ask before anything is retained, so the first library file is already safe.
  await ensurePersistentStorage(L.log, L.warn);

  // A folder prompt nobody answered must not cost the user their file. Gated on
  // the library existing so a profile that has never retained anything is not
  // made to open the history database just to be told there is nothing to do.
  try {
    if (await hasLibraryDirectory(await navigator.storage.getDirectory())) {
      await deliverAbandonedLocalRecordings();
    }
  } catch (e) {
    L.warn('Reconciling deferred local deliveries failed (non-fatal):', e);
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
