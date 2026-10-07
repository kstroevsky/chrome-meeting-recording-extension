import { createAlarm } from '../../platform/chrome/alarms';
import { loadExtensionSettingsFromStorage } from '../../shared/settings';
import {
  pendingLocalDeliveries,
  type PendingLocalDelivery,
  type RecordingHistoryCursor,
} from '../../shared/recordingHistory';
import type { FolderPreset } from '../../shared/settings';
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
    /** The local folder preset a recording's *Save to* destination files into, if any. */
    private readonly destinationFolderId: (recordingId: string) => Promise<string | undefined> = async () => undefined,
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

  async listPending(): Promise<PendingLocalDelivery[]> {
    const pending: PendingLocalDelivery[] = [];
    const presets = await this.localFolders();
    let cursor: RecordingHistoryCursor | undefined;
    for (let page = 0; page < 200; page += 1) {
      const result = await this.historyRepository.listPage({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of result.entries) {
        if (pendingLocalDeliveries(entry).length > 0) {
          const folder = await this.destinationFolder(entry.id, presets);
          pending.push({ id: entry.id, name: entry.name, ...(folder ? { folderId: folder.id } : {}) });
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
    if (outcomes.length === 0) {
      throw new Error('This recording has no pending local files to deliver');
    }
    const allLanded = outcomes.every((outcome) => outcome.status === 'complete');
    if (allLanded) {
      await this.history.setLocalFolder(recordingId, folder);
      return;
    }
    const summary = outcomes.map((outcome) => outcome.status).join(', ');
    this.logger.warn(`Local delivery for ${recordingId} did not fully complete:`, summary);
    throw new Error(`Local delivery did not fully complete (${summary})`);
  }

  /**
   * Writes recordings nobody was asked about. One started with a *Save to*
   * destination lands in that destination's folder, as the user picked at Start;
   * the rest go to the download directory, as before destinations existed.
   */
  async reconcileAbandoned(): Promise<boolean> {
    try {
      const presets = await this.localFolders();
      for (const pending of await this.listPending()) {
        const entry = await this.historyRepository.get(pending.id);
        if (!entry) continue;
        const folder = presets.find((preset) => preset.id === pending.folderId)?.name;
        const outcomes = await this.deliverDeferred(entry, folder);
        if (folder && outcomes.length && outcomes.every((outcome) => outcome.status === 'complete')) {
          await this.history.setLocalFolder(entry.id, folder);
        }
      }
      return (await this.listPending()).length === 0;
    } catch (error) {
      this.logger.warn('Reconciling deferred local deliveries failed:', error);
      return false;
    }
  }

  private async localFolders(): Promise<FolderPreset[]> {
    try {
      return (await loadExtensionSettingsFromStorage()).storage.localFolderPresets;
    } catch {
      return [];
    }
  }

  private async destinationFolder(recordingId: string, presets: FolderPreset[]): Promise<FolderPreset | undefined> {
    const id = await this.destinationFolderId(recordingId).catch(() => undefined);
    return id ? presets.find((preset) => preset.id === id) : undefined;
  }

  private async scheduleAbandonedSweep(): Promise<void> {
    try {
      await createAlarm(ABANDONED_DELIVERY_ALARM, { delayInMinutes: 0.5 });
    } catch (error) {
      this.logger.warn('Could not schedule the local delivery sweep:', error);
    }
  }
}
