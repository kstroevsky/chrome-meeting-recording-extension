import {
  closeOffscreenDocument,
  createOffscreenDocument,
  hasOffscreenDocument,
  requestOffscreenReconnect,
} from '../../platform/chrome/offscreen';
import { createRuntimeTab, removeTab } from '../../platform/chrome/tabs';
import { withTimeout } from '../../shared/async';
import { getBuildId } from '../../shared/build';
import { TIMEOUTS } from '../../shared/timeouts';
import type { OffscreenConnection } from './OffscreenConnection';

const RECORDER_TAB_CLEANUP_DELAY_MS = 15_000;

export class OffscreenHost {
  private recreating = false;
  private runtimeTransitioning = false;
  private recorderTabId: number | null = null;
  private recorderTabCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connection: OffscreenConnection,
    private readonly L: {
      log: (...a: any[]) => void;
      warn: (...a: any[]) => void;
      error: (...a: any[]) => void;
    },
  ) {}

  isTransitioning(): boolean {
    return this.recreating || this.runtimeTransitioning;
  }

  hasRecorderTab(): boolean {
    return this.recorderTabId != null;
  }

  async ensureReady(): Promise<void> {
    if (this.connection.currentPort && this.connection.isReady) return;
    const readyPromise = this.connection.getOrCreateReadyPromise();

    if (!(await hasOffscreenDocument())) {
      this.L.log('Creating offscreen document…');
      await this.createDoc();
    } else {
      await requestOffscreenReconnect();
    }
    await withTimeout(readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Offscreen ready');
  }

  async ensureRecorderTabReady(): Promise<number> {
    if (this.recorderTabId != null
      && this.connection.currentPort
      && this.connection.isReady) {
      this.cancelRecorderTabCleanup();
      return this.recorderTabId;
    }

    this.cancelRecorderTabCleanup();
    this.runtimeTransitioning = true;
    this.connection.markNotReady();
    this.connection.resetReadyPromise();
    const readyPromise = this.connection.getOrCreateReadyPromise();

    try {
      this.connection.clearPort(true);
      await closeOffscreenDocument();
      await this.waitUntilOffscreenGone();
      await this.closeRecorderTab();

      const tab = await createRuntimeTab('offscreen.html?runtime=tab', { active: true });
      if (typeof tab.id !== 'number') {
        throw new Error('Chrome did not return an id for the recorder extension tab');
      }
      this.recorderTabId = tab.id;
      await withTimeout(
        readyPromise,
        TIMEOUTS.READY_TIMEOUT_MS,
        'Recorder extension tab ready',
      );
      this.L.warn(
        'Using normal extension tab runtime for tab capture compatibility',
        tab.id,
      );
      return tab.id;
    } catch (error) {
      await this.closeRecorderTab();
      this.connection.failReady(error);
      throw error;
    } finally {
      this.runtimeTransitioning = false;
    }
  }

  handleReady(version: string | undefined): boolean {
    const expected = getBuildId();
    if (expected && version !== expected && !this.recreating) {
      this.recreating = true;
      this.L.warn(
        `Offscreen version mismatch (offscreen=${version ?? 'none'}, extension=${expected}); recreating offscreen`,
      );
      void this.recreateStaleOffscreen();
      return false;
    }

    this.recreating = false;
    this.connection.markReady();
    this.L.log('Offscreen is READY (Port)');
    return true;
  }

  async closeForUpdate(busy: boolean): Promise<boolean> {
    if (busy) {
      this.L.log('Update arrived during active work; deferring offscreen refresh');
      return false;
    }

    this.runtimeTransitioning = true;
    try {
      this.connection.markNotReady();
      this.cancelRecorderTabCleanup();
      this.connection.clearPort(true);
      await closeOffscreenDocument();
      await this.closeRecorderTab();
      this.connection.resetReadyPromise();
      this.L.log('Discarded stale offscreen document after extension update');
      return true;
    } finally {
      this.runtimeTransitioning = false;
    }
  }

  cancelRecorderTabCleanup(): void {
    if (this.recorderTabCleanupTimer == null) return;
    clearTimeout(this.recorderTabCleanupTimer);
    this.recorderTabCleanupTimer = null;
  }

  scheduleRecorderTabCleanup(canClose: () => boolean): void {
    if (this.recorderTabId == null) return;
    this.cancelRecorderTabCleanup();
    this.recorderTabCleanupTimer = setTimeout(() => {
      this.recorderTabCleanupTimer = null;
      if (!canClose()) return;
      void this.closeRecorderTab();
    }, RECORDER_TAB_CLEANUP_DELAY_MS);
  }

  private async recreateStaleOffscreen(): Promise<void> {
    try {
      this.connection.markNotReady();
      this.connection.clearPort(true);
      await closeOffscreenDocument();
      await this.waitUntilOffscreenGone();
      await this.createDoc();
      this.L.log(
        'Recreated offscreen document from current code; awaiting fresh READY',
      );
    } catch (error) {
      this.L.error('Offscreen recreate after version mismatch failed', error);
      this.recreating = false;
      this.connection.failReady(error);
    }
  }

  private async createDoc(): Promise<void> {
    await createOffscreenDocument('offscreen.html', {
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder',
    });
  }

  private async waitUntilOffscreenGone(maxMs = 1_500): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      if (!(await hasOffscreenDocument())) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async closeRecorderTab(): Promise<void> {
    this.cancelRecorderTabCleanup();
    const tabId = this.recorderTabId;
    this.recorderTabId = null;
    if (tabId == null) return;
    try {
      await removeTab(tabId);
    } catch {}
  }
}
