import { existsByKey, hasLibraryDirectory, listLibraryFiles, removeByKey } from '../../offscreen/storage/opfsLayout';
import { reconcileRetainedMedia } from '../retention/RetainedMediaReconciler';
import { ensurePersistentStorage } from '../retention/storageDurability';
import type { DrivePlaybackAuthLeaseManager } from '../playback/DrivePlaybackAuthLeaseManager';
import type { PlaybackLeaseManager } from '../playback/PlaybackLeaseManager';
import type { LocalDeliveryOrchestrator } from '../delivery/LocalDeliveryOrchestrator';
import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

const RECONCILED_KEY = 'retainedMediaReconciled';

/** Best-effort crash/startup reconciliation that runs once per browser session. */
export class StartupRecovery {
  constructor(
    private readonly historyRepository: RecordingHistoryRepository,
    private readonly history: RecordingHistoryService,
    private readonly localDelivery: LocalDeliveryOrchestrator,
    private readonly driveAuthLease: DrivePlaybackAuthLeaseManager,
    private readonly playbackLeases: PlaybackLeaseManager,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    const already = await chrome.storage.session.get(RECONCILED_KEY)
      .catch(() => ({} as Record<string, unknown>));
    if ((already as Record<string, unknown>)[RECONCILED_KEY]) return;
    await chrome.storage.session.set({ [RECONCILED_KEY]: true }).catch(() => {});

    await this.reconcileRetained();
    await ensurePersistentStorage(this.logger.log, this.logger.warn);
    await this.reconcileDeferredDelivery();
    await this.reconcilePlaybackLeases();
  }

  private async reconcileRetained(): Promise<void> {
    try {
      const report = await reconcileRetainedMedia({
        hasRetainedLibrary: async () => hasLibraryDirectory(await navigator.storage.getDirectory()),
        listRetained: async () => listLibraryFiles(await navigator.storage.getDirectory()),
        getEntry: (id) => this.historyRepository.get(id),
        listLiveEntries: () => this.history.list(),
        exists: async (key) => existsByKey(await navigator.storage.getDirectory(), key),
        removeRetained: async (key) => removeByKey(await navigator.storage.getDirectory(), key),
        recordLocation: (historyId, fileId, key, retainedAt) =>
          this.history.recordArtifactLocation(historyId, fileId, { kind: 'opfs', key, retainedAt }),
        dropLocation: (historyId, fileId, key) => this.history.dropArtifactLocation(historyId, fileId, key),
        log: this.logger.log,
        warn: this.logger.warn,
      });
      if (report.repaired || report.collected || report.staleLocations) {
        this.logger.log('Retained-media reconciliation:', report);
      }
    } catch (error) {
      this.logger.warn('Retained-media reconciliation failed (non-fatal):', error);
    }
  }

  private async reconcileDeferredDelivery(): Promise<void> {
    try {
      if (await hasLibraryDirectory(await navigator.storage.getDirectory())) {
        await this.localDelivery.reconcileAbandoned();
      }
    } catch (error) {
      this.logger.warn('Reconciling deferred local deliveries failed (non-fatal):', error);
    }
  }

  private async reconcilePlaybackLeases(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({});
      const liveTabIds = tabs.map((tab) => tab.id).filter((id): id is number => id != null);
      const dropped = await this.driveAuthLease.reconcile(liveTabIds);
      if (dropped) this.logger.log(`Dropped ${dropped} orphaned Drive playback rule(s)`);
      const freed = await this.playbackLeases.reconcile(liveTabIds);
      if (freed) this.logger.log(`Freed retained media for ${freed} recording(s) whose player is gone`);
    } catch (error) {
      this.logger.warn('Playback lease reconciliation failed (non-fatal):', error);
    }
  }
}
