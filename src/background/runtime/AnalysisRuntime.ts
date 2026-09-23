import type { RecordingAnalysisCoordinator } from '../library/analysis/RecordingAnalysisCoordinator';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { CriticalWorkCoordinator } from './CriticalWorkCoordinator';

type Logger = {
  warn: (...args: any[]) => void;
};

/** Owns the runtime wiring between offscreen analysis events and library services. */
export function wireAnalysisRuntime({
  offscreen,
  analysisCoordinator,
  criticalWork,
  logger,
}: {
  offscreen: OffscreenManager;
  analysisCoordinator: RecordingAnalysisCoordinator;
  criticalWork: CriticalWorkCoordinator;
  logger: Logger;
}): void {
  offscreen.onAnalysisJobChanged = (job) => {
    criticalWork.markAnalysisWorkKnown();
    analysisCoordinator.handleJobState(job);
    criticalWork.sync();
  };
  offscreen.onAnalysisResult = (job, analysis, provenance) => {
    void analysisCoordinator.handleResult(job, analysis, provenance)
      .catch((error) => logger.warn('Could not handle an analysis result', job.historyId, error))
      .finally(() => criticalWork.sync());
  };
}
