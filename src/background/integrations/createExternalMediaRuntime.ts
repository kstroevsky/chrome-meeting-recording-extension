import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { RecordingContextService } from '../library/context/RecordingContextService';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { CriticalWorkCoordinator } from '../runtime/CriticalWorkCoordinator';
import type { BackgroundIntegrationRuntime } from './BackgroundIntegrationRuntime';
import { ExternalMediaCoordinator } from './ExternalMediaCoordinator';
import { ExternalMediaRetryScheduler } from './ExternalMediaRetryScheduler';

type Logger = { warn: (...args: any[]) => void };

export function createExternalMediaRuntime(deps: {
  offscreen: OffscreenManager;
  integrations: BackgroundIntegrationRuntime;
  history: RecordingHistoryService;
  historyRepository: RecordingHistoryRepository;
  recordingContexts: RecordingContextService;
  criticalWork: CriticalWorkCoordinator;
  logger: Logger;
}) {
  let reconcile: () => Promise<void> = async () => {};
  const retryScheduler = new ExternalMediaRetryScheduler(() => reconcile());
  const coordinator = new ExternalMediaCoordinator({
    offscreen: deps.offscreen,
    integrations: deps.integrations,
    history: deps.history,
    historyRepository: deps.historyRepository,
    recordingContexts: deps.recordingContexts,
    listHistory: () => deps.historyRepository.listAllIncludingDeleted(),
    retryScheduler,
    logger: deps.logger,
  });
  reconcile = () => coordinator.reconcile();

  deps.offscreen.onExternalMediaStateChanged = (transfer) => {
    deps.criticalWork.sync();
    void coordinator.handleState(transfer)
      .catch((error) => deps.logger.warn('External media state reconciliation deferred:', error))
      .finally(() => deps.criticalWork.sync());
  };

  return {
    coordinator,
    retryScheduler,
    notifyIntegrationChanged(recordingId: string): void {
      void deps.integrations.consider(recordingId)
        .catch((error) => deps.logger.warn('Integration recording consideration deferred:', error));
      void coordinator.reconcileRecording(recordingId)
        .catch((error) => deps.logger.warn('External media recording reconciliation deferred:', error));
    },
  };
}
