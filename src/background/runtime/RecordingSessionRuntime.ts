import { sendTabMessage } from '../../platform/chrome/tabs';
import { setSessionStorageValues } from '../../platform/chrome/storage';
import { broadcastToPopup } from '../../shared/messages';
import {
  RECORDING_SESSION_STORAGE_KEY,
  toStatusView,
  type RecordingPhase,
} from '../../shared/recording';
import { TIMEOUTS } from '../../shared/timeouts';
import type { RecordingAnalysisCoordinator } from '../library/analysis/RecordingAnalysisCoordinator';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { PerfDebugStore } from '../observability/perf/PerfDebugStore';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import { createPhaseWatchdog } from '../recording/phaseWatchdog';
import type { RecordingSession, SessionPersistor } from '../recording/session/RecordingSession';
import { markCaptureSettled, noteCaptureProgress } from '../recording/unsavedCaptureFlag';
import { isFreshRecordingStart } from './KeepAlive';
import type { CriticalWorkCoordinator } from './CriticalWorkCoordinator';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

type SessionRuntimeDeps = {
  session: RecordingSession;
  offscreen: OffscreenManager;
  telemetry: TelemetryRuntime;
  perfDebugStore: PerfDebugStore;
  transcriptCapture: RecordingTranscriptCapture;
  transcripts: RecordingTranscriptService;
  notations: RecordingNotationService;
  analysisCoordinator: RecordingAnalysisCoordinator;
  criticalWork: CriticalWorkCoordinator;
  isHydrated: () => boolean;
  logger: Logger;
};

/** Persists the canonical session and its crash-recovery clock mirror. */
export function createSessionPersistor(logger: Logger): SessionPersistor {
  return async (snapshot) => {
    if (snapshot.phase === 'recording' || snapshot.phase === 'stopping') {
      void noteCaptureProgress({
        recordedMs: snapshot.recordedMs ?? 0,
        runningSince: snapshot.paused === true ? null : snapshot.runningSince ?? null,
      });
    }
    try {
      await setSessionStorageValues({ [RECORDING_SESSION_STORAGE_KEY]: snapshot });
    } catch (error) {
      logger.warn('storage.session.set failed (recording session):', error);
      throw error;
    }
  };
}

/** Wires the canonical session to liveness, offscreen state, transcript and analysis side effects. */
export function wireRecordingSessionRuntime(deps: SessionRuntimeDeps): void {
  let previousPhase: RecordingPhase = 'idle';
  const phaseWatchdog = createPhaseWatchdog({
    budgets: {
      starting: TIMEOUTS.STARTING_WATCHDOG_MS,
      stopping: TIMEOUTS.STOPPING_WATCHDOG_MS,
    },
    getSnapshot: () => deps.session.getSnapshot(),
    onStuck: (snapshot) => {
      const error = snapshot.phase === 'stopping'
        ? 'Recording stop timed out — the recorder never confirmed finalize. Any captured file is recovered on the next launch.'
        : 'Recording start timed out — the recorder never confirmed it began.';
      deps.logger.warn(
        `Phase watchdog: session stuck in '${snapshot.phase}'; failing it and tearing down the offscreen so a retry starts clean`,
      );
      deps.session.fail(error);
      void deps.offscreen.closeForUpdate()
        .catch((cause) => deps.logger.warn('Watchdog offscreen teardown failed (non-fatal):', cause));
    },
  });

  deps.session.bindListeners({
    onChanged: (snapshot) => {
      phaseWatchdog.observe(snapshot);
      deps.offscreen.hydratePhase(snapshot.phase);
      deps.offscreen.hydrateUploadJobs?.(snapshot.uploadJobs);
      if (deps.isHydrated() && isFreshRecordingStart(previousPhase, snapshot.phase)) {
        deps.perfDebugStore.clear();
        if (snapshot.targetTabId != null && snapshot.epoch != null) {
          void deps.transcriptCapture.arm(snapshot.targetTabId, snapshot.epoch);
        }
      }
      previousPhase = snapshot.phase;
      deps.perfDebugStore.setPhase(snapshot.phase);
      deps.criticalWork.sync(snapshot);
      broadcastToPopup({ type: 'RECORDING_STATE', session: toStatusView(snapshot) });
    },
    onRunFinished: (historyId, durationMs, ending) => {
      if (ending === 'discarded') {
        void deps.transcriptCapture.abandon()
          .catch((error) => deps.logger.warn(
            'Could not disarm transcript capture for the discarded run:',
            error,
          ));
        return;
      }
      void deps.notations.closeOpenSpans(historyId, durationMs)
        .catch((error) => deps.logger.warn('Could not close open notations for the finished run:', error));
      void deps.transcriptCapture.finish(historyId)
        .then(() => deps.analysisCoordinator.analyze(historyId))
        .then((started) => {
          if (!started.ok && started.reason !== 'no-transcript') {
            deps.logger.warn(
              `Topic analysis did not start for ${historyId}: ${started.reason}`,
              started.error ?? '',
            );
          }
        })
        .catch((error) => deps.logger.warn('Could not finish transcript capture for the run:', error));
    },
  });

  deps.offscreen.onStateChanged = (msg) => {
    const currentEpoch = deps.session.getSnapshot().epoch;
    if (currentEpoch != null && msg.epoch !== currentEpoch) {
      deps.logger.log(
        `Ignoring stale OFFSCREEN_STATE (epoch ${msg.epoch ?? 'none'} != current ${currentEpoch})`,
      );
      return;
    }
    deps.session.applyOffscreenPhase(msg);
    if (msg.phase === 'idle') void markCaptureSettled();
    if (!msg.telemetrySnapshot) return;
    void deps.telemetry.receive(msg.telemetrySnapshot, true).then(() => {
      if (msg.phase === 'idle') {
        const runId = msg.telemetrySnapshot!.runId;
        deps.telemetry.completeRecording(runId);
        setTimeout(() => { void deps.telemetry.flushRun(runId, 'recording_complete'); }, 250);
      }
      if (msg.phase === 'failed') {
        const runId = msg.telemetrySnapshot!.runId;
        setTimeout(() => { void deps.telemetry.flushIncidentRun(runId); }, 0);
      }
    });
  };
}

/** Builds transcript capture after the canonical session exists. */
export function createTranscriptCapture(
  session: RecordingSession,
  transcripts: RecordingTranscriptService,
  logger: Logger,
): RecordingTranscriptCapture {
  return new RecordingTranscriptCapture({
    transcripts,
    activeHistoryId: () => session.getSnapshot().historyId,
    activeRunId: () => session.getSnapshot().epoch,
    recordedRangeAt: (startWallMs, endWallMs) => session.recordedRangeAt(startWallMs, endWallMs),
    sendToTab: (tabId, message) => sendTabMessage(tabId, message),
    warn: logger.warn,
  });
}
