import {
  hasUploadsInFlight,
  isBusyPhase,
  type RecordingSessionSnapshot,
} from '../../shared/recording';
import { startKeepAlive, stopKeepAlive } from './KeepAlive';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

type CriticalWorkDeps = {
  getSnapshot: () => RecordingSessionSnapshot;
  hasActiveAnalysisJobs: () => boolean;
  refreshAnalysisWork: () => Promise<unknown>;
  hasActiveExternalMediaTransfers: () => boolean;
  refreshExternalMediaWork: () => Promise<unknown>;
  reload: () => void;
  logger: Logger;
};

const ANALYSIS_WORK_RETRY_MS = 30_000;

/**
 * Owns the definition of work that an extension reload must not destroy.
 * Recording/upload state is durable; active analysis is queried from the data
 * plane and an unknown answer is deliberately treated as busy.
 */
export class CriticalWorkCoordinator {
  private pendingReload = false;
  private analysisWorkUnknown = false;
  private externalMediaWorkUnknown = false;
  private analysisWorkRetry: ReturnType<typeof setTimeout> | null = null;
  private externalMediaWorkRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CriticalWorkDeps) {}

  hasWork(snapshot = this.deps.getSnapshot()): boolean {
    return isBusyPhase(snapshot.phase)
      || hasUploadsInFlight(snapshot.uploadJobs)
      || this.deps.hasActiveAnalysisJobs()
      || this.analysisWorkUnknown
      || this.deps.hasActiveExternalMediaTransfers()
      || this.externalMediaWorkUnknown;
  }

  async confirmAnalysisWork(): Promise<void> {
    try {
      await this.deps.refreshAnalysisWork();
      this.markAnalysisWorkKnown();
    } catch (error) {
      this.analysisWorkUnknown = true;
      this.deps.logger.warn(
        'Could not confirm what the data plane is analysing; treating it as busy',
        error,
      );
      if (!this.analysisWorkRetry) {
        this.analysisWorkRetry = setTimeout(() => {
          this.analysisWorkRetry = null;
          void this.confirmAnalysisWork().then(() => this.sync());
        }, ANALYSIS_WORK_RETRY_MS);
      }
    }
  }

  markAnalysisWorkKnown(): void {
    if (!this.analysisWorkUnknown) return;
    this.analysisWorkUnknown = false;
    if (this.analysisWorkRetry) {
      clearTimeout(this.analysisWorkRetry);
      this.analysisWorkRetry = null;
    }
  }

  async confirmExternalMediaWork(): Promise<void> {
    try {
      await this.deps.refreshExternalMediaWork();
      this.markExternalMediaWorkKnown();
    } catch (error) {
      this.externalMediaWorkUnknown = true;
      this.deps.logger.warn(
        'Could not confirm external media work; treating it as busy',
        error,
      );
      if (!this.externalMediaWorkRetry) {
        this.externalMediaWorkRetry = setTimeout(() => {
          this.externalMediaWorkRetry = null;
          void this.confirmExternalMediaWork().then(() => this.sync());
        }, ANALYSIS_WORK_RETRY_MS);
      }
    }
  }

  markExternalMediaWorkKnown(): void {
    if (!this.externalMediaWorkUnknown) return;
    this.externalMediaWorkUnknown = false;
    if (this.externalMediaWorkRetry) {
      clearTimeout(this.externalMediaWorkRetry);
      this.externalMediaWorkRetry = null;
    }
  }

  sync(snapshot = this.deps.getSnapshot()): void {
    if (this.hasWork(snapshot)) {
      startKeepAlive();
      return;
    }

    stopKeepAlive();
    if (!this.pendingReload) return;
    this.pendingReload = false;
    this.deps.logger.log('Applying deferred update reload now that work has finished');
    this.deps.reload();
  }

  markReloadPending(): void {
    this.pendingReload = true;
  }

  async applyUpdateWhenSafe(): Promise<void> {
    if (this.hasWork()) {
      this.deps.logger.log('Update available; deferring reload until current work finishes');
      this.pendingReload = true;
      this.sync();
      return;
    }

    await Promise.all([
      this.confirmAnalysisWork(),
      this.confirmExternalMediaWork(),
    ]);
    if (this.hasWork()) {
      this.deps.logger.log('Update available; deferring reload until data-plane work finishes');
      this.pendingReload = true;
      this.sync();
      return;
    }

    this.deps.logger.log('Update available; reloading to apply');
    this.deps.reload();
  }
}
