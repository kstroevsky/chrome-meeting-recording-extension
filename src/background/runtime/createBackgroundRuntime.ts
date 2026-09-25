import { listLibraryFiles, removeByKey } from '../../offscreen/storage/opfsLayout';
import { reloadRuntime } from '../../platform/chrome/runtime';
import { getSessionStorageValues, setSessionStorageValues } from '../../platform/chrome/storage';
import { makeLogger } from '../../shared/logger';
import { getPerfSettingsSnapshot } from '../../shared/perf';
import { fetchDriveTokenWithFallback } from '../drive/driveAuth';
import { DriveLibraryCoordinator } from '../drive/DriveLibraryCoordinator';
import { createLibraryRuntime } from '../library/createLibraryRuntime';
import { LocalDeliveryOrchestrator } from '../delivery/LocalDeliveryOrchestrator';
import { createMessageListener } from '../messaging/MessageRouter';
import { createChromeCpuSampler } from '../observability/perf/CpuSampler';
import { PerfDebugStore } from '../observability/perf/PerfDebugStore';
import { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import { OffscreenManager } from '../offscreen/OffscreenManager';
import { DrivePlaybackAuthLeaseManager } from '../playback/DrivePlaybackAuthLeaseManager';
import { PlaybackLeaseManager, type PlaybackLeaseState } from '../playback/PlaybackLeaseManager';
import { RecordingController } from '../recording/RecordingController';
import { RecordingSession } from '../recording/session/RecordingSession';
import { UnsavedRecordingRecovery } from '../recording/UnsavedRecordingRecovery';
import { readStorageUsage } from '../retention/storageDurability';
import { CriticalWorkCoordinator } from './CriticalWorkCoordinator';
import {
  createSessionPersistor,
  createTranscriptCapture,
  wireRecordingSessionRuntime,
} from './RecordingSessionRuntime';
import { StartupRecovery } from './StartupRecovery';
import { UploadStatePersistence } from './UploadStatePersistence';
import { wireAnalysisRuntime } from './AnalysisRuntime';
import { bootstrapBackground } from './bootstrap';
import { BackgroundReadiness } from './BackgroundReadiness';
import { BackgroundSharingRuntime } from '../sharing/BackgroundSharingRuntime';

const PLAYBACK_LEASE_STORAGE_KEY = 'playbackLeases';
/** Builds the synchronous background object graph; Chrome listener registration stays in background.ts. */
export function createBackgroundRuntime() {
  const logger = makeLogger('background');
  const readiness = new BackgroundReadiness();
  const offscreen = new OffscreenManager();
  const sharing = new BackgroundSharingRuntime(offscreen);
  const telemetry = new TelemetryRuntime();
  const perfDebugStore = new PerfDebugStore(getPerfSettingsSnapshot(), logger.warn);
  const session = new RecordingSession(createSessionPersistor(logger));

  const criticalWork = new CriticalWorkCoordinator({
    getSnapshot: () => session.getSnapshot(),
    hasActiveAnalysisJobs: () => offscreen.hasActiveAnalysisJobs(),
    refreshAnalysisWork: () => offscreen.refreshAnalysisWork(),
    reload: reloadRuntime,
    logger,
  });
  const playbackLeases = new PlaybackLeaseManager({
    read: async () => (
      await getSessionStorageValues(PLAYBACK_LEASE_STORAGE_KEY)
    )?.[PLAYBACK_LEASE_STORAGE_KEY] as PlaybackLeaseState | undefined,
    write: async (state) => {
      await setSessionStorageValues({ [PLAYBACK_LEASE_STORAGE_KEY]: state });
    },
    deleteRetained: async (keys) => {
      const root = await navigator.storage.getDirectory();
      for (const key of keys) await removeByKey(root, key);
    },
    warn: logger.warn,
  });
  const driveAuthLease = new DrivePlaybackAuthLeaseManager({
    getToken: async (options) => {
      const result = await fetchDriveTokenWithFallback({ refresh: options?.refresh === true });
      if (!result.ok) throw new Error(result.error);
      return result.token;
    },
    warn: logger.warn,
  });

  const library = createLibraryRuntime({
    offscreen,
    playbackLeases,
    logger,
    onAnalysisSettled: () => criticalWork.sync(),
  });
  wireAnalysisRuntime({
    offscreen,
    analysisCoordinator: library.analysisCoordinator,
    criticalWork,
    logger,
  });
  const driveLibrary = new DriveLibraryCoordinator(
    library.historyRepository,
    library.history,
    logger,
  );
  const transcriptCapture = createTranscriptCapture(session, library.transcripts, logger);

  let sessionHydrated = false;
  wireRecordingSessionRuntime({
    session,
    offscreen,
    telemetry,
    perfDebugStore,
    transcriptCapture,
    transcripts: library.transcripts,
    notations: library.notations,
    analysisCoordinator: library.analysisCoordinator,
    criticalWork,
    isHydrated: () => sessionHydrated,
    logger,
  });

  const uploadStatePersistence = new UploadStatePersistence(
    session,
    library.history,
    offscreen,
    telemetry,
    logger,
  );
  offscreen.onUploadJobChanged = (...args) => uploadStatePersistence.handleChanged(...args);

  const localDelivery = new LocalDeliveryOrchestrator(
    offscreen,
    library.history,
    library.historyRepository,
    (historyId) => session.runDurationMs(historyId),
    logger,
  );
  const startupRecovery = new StartupRecovery(
    library.historyRepository,
    library.history,
    localDelivery,
    driveAuthLease,
    playbackLeases,
    logger,
  );
  const unsavedRecovery = new UnsavedRecordingRecovery(offscreen, session, logger);
  const controller = new RecordingController({
    L: logger,
    offscreen,
    session,
    telemetry,
    notations: library.notations,
    transcripts: library.transcripts,
    transcriptCapture,
  });

  const messageListener = createMessageListener({
    L: logger,
    session,
    perfDebugStore,
    controller,
    cpuSampler: createChromeCpuSampler(),
    history: library.history,
    notations: library.notations,
    transcripts: library.transcripts,
    analyses: library.analyses,
    transcriptCapture,
    playback: library.playback,
    playbackLeases,
    driveArtifacts: driveLibrary.artifacts,
    fileToDestination: (recordingId, presetId) =>
      driveLibrary.fileRecordingToDestination(recordingId, presetId),
    renameDriveRootFolder: (from, to) => driveLibrary.renameRootFolder(from, to),
    listUnsavedRecordings: () => unsavedRecovery.list(),
    resolveUnsavedRecording: (key, action, name) => unsavedRecovery.resolve(key, action, name),
    listPendingLocal: () => localDelivery.listPending(),
    deliverLocal: (recordingId, folderId) => localDelivery.deliver(recordingId, folderId),
    storageUsage: () => readStorageUsage(async () => {
      const files = await listLibraryFiles(await navigator.storage.getDirectory());
      return files.reduce((total, file) => total + file.sizeBytes, 0);
    }),
    driveAuthLease,
    telemetry,
    sharing,
    e2eAnalysisWork: () => offscreen.refreshAnalysisWork(),
    waitUntilReady: () => readiness.wait(),
  });

  const markSessionHydrated = () => {
    sessionHydrated = true;
    const snapshot = session.getSnapshot();
    if (snapshot.phase !== 'idle') {
      const finalization = snapshot.finalization;
      const targetTabId = finalization?.targetTabId ?? snapshot.targetTabId;
      const epoch = finalization?.epoch ?? snapshot.epoch;
      if (targetTabId != null && epoch != null) {
        void transcriptCapture.restore(
          targetTabId,
          epoch,
          finalization?.disposition ?? 'kept',
        );
      }
    }
    offscreen.releaseBufferedIngress();
    readiness.markReady();
  };
  const bootstrap = async () => {
    try {
      await bootstrapBackground({
        session,
        offscreen,
        telemetry,
        perfDebugStore,
        criticalWork,
        startupRecovery,
        markSessionHydrated,
        resumePendingFinalization: () => controller.resumePendingFinalization(),
        logger,
      });
      await sharing.resumeIfPending().catch((error) => logger.warn('Pending sharing recovery deferred:', error));
    } catch (error) {
      if (!sessionHydrated) readiness.markFailed(error);
      logger.error('Critical background session hydration failed:', error);
      throw error;
    }
  };

  return {
    logger,
    session,
    controller,
    driveLibrary,
    messageListener,
    bootstrap,
    waitUntilReady: () => readiness.wait(),
    handleAlarm: (alarm: chrome.alarms.Alarm) => localDelivery.handleAlarm(alarm),
    handleConnect: (port: chrome.runtime.Port) => {
      if (port.name === 'offscreen') offscreen.attachPort(port);
    },
    handleSuspend: () => offscreen.stopIfPossibleOnSuspend(session.getSnapshot().epoch),
    applyUpdateWhenSafe: () => criticalWork.applyUpdateWhenSafe(),
    handleUpdatedExtension: async () => {
      logger.log('Extension updated; refreshing offscreen document');
      await driveLibrary.tidyOnce();
      const closed = await offscreen.closeForUpdate();
      if (!closed) criticalWork.markReloadPending();
    },
    releasePlaybackTab: (tabId: number) => {
      void driveAuthLease.releaseTab(tabId)
        .catch((error) => logger.warn('Drive lease release failed:', error));
      void playbackLeases.releaseTab(tabId)
        .then((freed) => {
          if (freed) logger.log(`Freed retained media for ${freed} deleted recording(s)`);
        })
        .catch((error) => logger.warn('Playback lease release failed:', error));
    },
    handleGlobalError: (event: ErrorEvent) => {
      telemetry.incident({ kind: 'application_error', stage: 'runtime', error: event.error });
    },
    handleUnhandledRejection: (event: PromiseRejectionEvent) => {
      telemetry.incident({ kind: 'unhandled_rejection', stage: 'runtime', error: event.reason });
    },
  };
}
