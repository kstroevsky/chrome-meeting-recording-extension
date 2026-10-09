import { listLibraryFiles } from '../../offscreen/storage/opfsLayout';
import { reloadRuntime } from '../../platform/chrome/runtime';
import { makeLogger } from '../../shared/logger';
import { getPerfSettingsSnapshot } from '../../shared/perf';
import { DriveLibraryCoordinator } from '../drive/DriveLibraryCoordinator';
import { createLibraryRuntime } from '../library/createLibraryRuntime';
import { LocalDeliveryOrchestrator } from '../delivery/LocalDeliveryOrchestrator';
import { createMessageListener } from '../messaging/MessageRouter';
import { createChromeCpuSampler } from '../observability/perf/CpuSampler';
import { PerfDebugStore } from '../observability/perf/PerfDebugStore';
import { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import { OffscreenManager } from '../offscreen/OffscreenManager';
import { RecordingController } from '../recording/RecordingController';
import { RecordingSession } from '../recording/session/RecordingSession';
import { UnsavedRecordingRecovery } from '../recording/UnsavedRecordingRecovery';
import { readStorageUsage } from '../retention/storageDurability';
import { CriticalWorkCoordinator } from './CriticalWorkCoordinator';
import { createSessionPersistor, createTranscriptCapture, wireRecordingSessionRuntime } from './RecordingSessionRuntime';
import { StartupRecovery } from './StartupRecovery';
import { UploadStatePersistence } from './UploadStatePersistence';
import { wireAnalysisRuntime } from './AnalysisRuntime';
import { bootstrapBackground } from './bootstrap';
import { BackgroundReadiness } from './BackgroundReadiness';
import { BackgroundSharingRuntime } from '../sharing/BackgroundSharingRuntime';
import { createIntegrationRuntime } from '../integrations/createIntegrationRuntime';
import { createExternalMediaRuntime } from '../integrations/createExternalMediaRuntime';
import { createPlaybackSupportRuntime } from './createPlaybackSupportRuntime';
import { recordingHistoryFileId } from '../../shared/recordingHistory';

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
    hasActiveExternalMediaTransfers: () => offscreen.hasActiveExternalMediaTransfers(),
    refreshExternalMediaWork: () => offscreen.refreshExternalMediaWork(),
    reload: reloadRuntime,
    logger,
  });
  const { playbackLeases, driveAuthLease } = createPlaybackSupportRuntime(logger);

  let notifyIntegrationChanged: (recordingId: string) => void = () => {};
  const library = createLibraryRuntime({
    offscreen,
    playbackLeases,
    logger,
    onAnalysisSettled: () => criticalWork.sync(),
    onIntegrationChanged: (recordingId) => notifyIntegrationChanged(recordingId),
  });
  const { integrations, destinations, routing: recordingRouting } = createIntegrationRuntime(library);
  const externalMediaRuntime = createExternalMediaRuntime({
    offscreen,
    integrations,
    history: library.history,
    historyRepository: library.historyRepository,
    recordingContexts: library.recordingContexts,
    criticalWork,
    logger,
  });
  notifyIntegrationChanged = externalMediaRuntime.notifyIntegrationChanged;
  offscreen.onRetainedPrimary = (retained) => {
    const durationMs = session.runDurationMs(retained.historyId);
    void (async () => {
      const fileId = recordingHistoryFileId(retained.historyId, retained.stream);
      await library.history.createPending(
        retained.historyId,
        [{
          id: fileId,
          stream: retained.stream,
          filename: retained.filename,
          bytes: retained.bytes,
          ...(retained.startOffsetMs != null ? { captureStartOffsetMs: retained.startOffsetMs } : {}),
        }],
        { kind: 'external', destinationId: retained.destinationId },
      );
      await library.history.setDuration(retained.historyId, durationMs);
      await library.history.recordArtifactLocation(retained.historyId, fileId, {
        kind: 'opfs',
        key: retained.retainedKey,
        retainedAt: retained.retainedAt,
      });
      offscreen.acknowledgeRetainedPrimary(retained.historyId, retained.stream);
    })().catch((error) => logger.warn('External primary retention handoff deferred:', error));
  };
  wireAnalysisRuntime({
    offscreen,
    analysisCoordinator: library.analysisCoordinator,
    criticalWork,
    logger,
  });
  const driveLibrary = new DriveLibraryCoordinator(library.historyRepository, library.history, logger);
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
    (recordingId) => destinations.driveFolderPresetFor(recordingId),
  );
  offscreen.onUploadJobChanged = (...args) => uploadStatePersistence.handleChanged(...args);

  const localDelivery = new LocalDeliveryOrchestrator(
    offscreen,
    library.history,
    library.historyRepository,
    (historyId) => session.runDurationMs(historyId),
    logger,
    (recordingId) => destinations.localFolderFor(recordingId),
  );
  const startupRecovery = new StartupRecovery(
    library.historyRepository,
    library.history,
    localDelivery,
    driveAuthLease,
    playbackLeases,
    logger,
    externalMediaRuntime.coordinator,
  );
  const unsavedRecovery = new UnsavedRecordingRecovery(offscreen, session, logger);
  const controller = new RecordingController({
    L: logger,
    offscreen,
    session,
    telemetry,
    recordingContexts: library.recordingContexts,
    notations: library.notations,
    transcripts: library.transcripts,
    transcriptCapture,
    destinations,
    routing: recordingRouting,
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
    driveLibrary,
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
    integrations,
    externalMedia: externalMediaRuntime.coordinator,
    destinations,
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
      await integrations.reconcile().catch((error) => logger.warn('Integration delivery recovery deferred:', error));
      await externalMediaRuntime.coordinator.reconcile()
        .catch((error) => logger.warn('External media recovery deferred:', error));
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
    handleAlarm: (alarm: chrome.alarms.Alarm) => {
      localDelivery.handleAlarm(alarm);
      integrations.handleAlarm(alarm);
      externalMediaRuntime.retryScheduler.handleAlarm(alarm);
    },
    handleConnect: (port: chrome.runtime.Port) => {
      if (port.name === 'offscreen' && offscreen.attachPort(port)) {
        void readiness.wait()
          .then(() => externalMediaRuntime.coordinator.reconcile())
          .catch((error) => logger.warn('External media reconnect recovery deferred:', error));
      }
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
