import { existsByKey, hasLibraryDirectory, listLibraryFiles, removeByKey } from '../../offscreen/storage/opfsLayout';
import { getSessionStorageValues, setSessionStorageValues } from '../../platform/chrome/storage';
import { queryTabs } from '../../platform/chrome/tabs';
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
    const already = await getSessionStorageValues(RECONCILED_KEY)
      .catch(() => ({} as Record<string, unknown>));
    if (already[RECONCILED_KEY]) return;

    const retainedOk = await this.reconcileRetained();
    await ensurePersistentStorage(this.logger.log, this.logger.warn);
    const cleanupOk = await this.reconcileDeletedHistory();
    const deliveryOk = await this.reconcileDeferredDelivery();
    const leasesOk = await this.reconcilePlaybackLeases();
    if (retainedOk && cleanupOk && deliveryOk && leasesOk) {
      await setSessionStorageValues({ [RECONCILED_KEY]: true }).catch((error) => {
        this.logger.warn('Could not persist startup reconciliation marker:', error);
      });
    }
  }

  private async reconcileRetained(): Promise<boolean> {
    try {
      const report = await reconcileRetainedMedia({
        hasRetainedLibrary: async () => hasLibraryDirectory(await navigator.storage.getDirectory()),
        listRetained: async () => listLibraryFiles(await navigator.storage.getDirectory()),
        getEntry: (id) => this.historyRepository.get(id),
        listLiveEntries: () => this.listAllLiveEntries(),
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
      return true;
    } catch (error) {
      this.logger.warn('Retained-media reconciliation failed (non-fatal):', error);
      return false;
    }
  }

  private async reconcileDeletedHistory(): Promise<boolean> {
    try {
      return await this.history.retryPendingCleanup();
    } catch (error) {
      this.logger.warn('Reconciling deleted recording cleanup failed (non-fatal):', error);
      return false;
    }
  }

  private async reconcileDeferredDelivery(): Promise<boolean> {
    try {
      if (await hasLibraryDirectory(await navigator.storage.getDirectory())) {
        return await this.localDelivery.reconcileAbandoned();
      }
      return true;
    } catch (error) {
      this.logger.warn('Reconciling deferred local deliveries failed (non-fatal):', error);
      return false;
    }
  }

  private async reconcilePlaybackLeases(): Promise<boolean> {
    try {
      const tabs = await queryTabs({});
      const liveTabIds = tabs.map((tab) => tab.id).filter((id): id is number => id != null);
      const dropped = await this.driveAuthLease.reconcile(liveTabIds);
      if (dropped) this.logger.log(`Dropped ${dropped} orphaned Drive playback rule(s)`);
      const freed = await this.playbackLeases.reconcile(liveTabIds);
      if (freed) this.logger.log(`Freed retained media for ${freed} recording(s) whose player is gone`);
      return true;
    } catch (error) {
      this.logger.warn('Playback lease reconciliation failed (non-fatal):', error);
      return false;
    }
  }

  private async listAllLiveEntries() {
    const entries = [];
    let cursor;
    for (let page = 0; page < 200; page += 1) {
      const result = await this.historyRepository.listPage({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      entries.push(...result.entries.filter((entry) => !entry.deletedAt));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return entries;
  }
}
