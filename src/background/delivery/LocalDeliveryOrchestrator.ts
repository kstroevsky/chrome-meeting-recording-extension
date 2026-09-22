import { createAlarm } from '../../platform/chrome/alarms';
import { loadExtensionSettingsFromStorage } from '../../shared/settings';
import { pendingLocalDeliveries, type RecordingHistoryCursor } from '../../shared/recordingHistory';
import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import { registerSaveHandler } from './LocalDeliveryRuntime';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

const ABANDONED_DELIVERY_ALARM = 'local-delivery-timeout';

/** Coordinates deferred local delivery around the low-level Chrome Downloads runtime. */
export class LocalDeliveryOrchestrator {
  private readonly deliverDeferred: ReturnType<typeof registerSaveHandler>['deliverDeferred'];

  constructor(
    offscreen: OffscreenManager,
    private readonly history: RecordingHistoryService,
    private readonly historyRepository: RecordingHistoryRepository,
    getRunDurationMs: (historyId: string) => number | undefined,
    private readonly logger: Logger,
  ) {
    const registered = registerSaveHandler(
      offscreen,
      logger,
      history,
      getRunDurationMs,
      async () => {
        try {
          return (await loadExtensionSettingsFromStorage()).storage.localFolderPresets.length;
        } catch {
          return 0;
        }
      },
      () => { void this.scheduleAbandonedSweep(); },
    );
    this.deliverDeferred = registered.deliverDeferred;
  }

  handleAlarm(alarm: { name: string }): void {
    if (alarm.name === ABANDONED_DELIVERY_ALARM) void this.reconcileAbandoned();
  }

  async listPending(): Promise<{ id: string; name: string }[]> {
    const pending: { id: string; name: string }[] = [];
    let cursor: RecordingHistoryCursor | undefined;
    for (let page = 0; page < 200; page += 1) {
      const result = await this.historyRepository.listPage({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of result.entries) {
        if (pendingLocalDeliveries(entry).length > 0) {
          pending.push({ id: entry.id, name: entry.name });
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return pending;
  }

  async deliver(recordingId: string, folderId: string | null): Promise<void> {
    const entry = await this.historyRepository.get(recordingId);
    if (!entry || entry.deletedAt) throw new Error('This recording is no longer available');

    let folder: string | undefined;
    if (folderId) {
      const settings = await loadExtensionSettingsFromStorage();
      folder = settings.storage.localFolderPresets.find((preset) => preset.id === folderId)?.name;
      if (!folder) throw new Error('That folder no longer exists');
    }

    const outcomes = await this.deliverDeferred(entry, folder);
    const allLanded = outcomes.length > 0
      && outcomes.every((outcome) => outcome.status === 'complete');
    if (allLanded) {
      await this.history.setLocalFolder(recordingId, folder);
    } else if (outcomes.some((outcome) => outcome.status !== 'complete')) {
      this.logger.warn(
        `Local delivery for ${recordingId} did not fully complete:`,
        outcomes.map((outcome) => outcome.status).join(', '),
      );
    }
  }

  async reconcileAbandoned(): Promise<void> {
    try {
      for (const pending of await this.listPending()) {
        const entry = await this.historyRepository.get(pending.id);
        if (entry) await this.deliverDeferred(entry);
      }
    } catch (error) {
      this.logger.warn('Reconciling deferred local deliveries failed:', error);
    }
  }

  private async scheduleAbandonedSweep(): Promise<void> {
    try {
      await createAlarm(ABANDONED_DELIVERY_ALARM, { delayInMinutes: 0.5 });
    } catch (error) {
      this.logger.warn('Could not schedule the local delivery sweep:', error);
    }
  }
}
