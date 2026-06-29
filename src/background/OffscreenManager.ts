/**
 * @file background/OffscreenManager.ts
 *
 * Owns the offscreen document lifecycle and forwards offscreen state to the
 * popup/background UI layer.
 */
import { setActionBadgeText } from '../platform/chrome/action';
import {
  closeOffscreenDocument,
  createOffscreenDocument,
  hasOffscreenDocument,
  requestOffscreenReconnect,
} from '../platform/chrome/offscreen';
import { createRuntimeTab, removeTab } from '../platform/chrome/tabs';
import { withTimeout } from '../shared/async';
import { getBuildId } from '../shared/build';
import { makeLogger } from '../shared/logger';
import { createPortRpcClient } from '../shared/rpc';
import type {
  BgToOffscreenRpc,
  OffscreenToBg,
} from '../shared/protocol';
import { isOffscreenToBgMessage } from '../shared/protocol';

export type OffscreenStateListener = (msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_STATE' }>) => void;
export type OffscreenSaveListener = (msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_SAVE' }>) => void;
export type OffscreenUploadListener = (job: UploadJob) => void;
import { TIMEOUTS } from '../shared/timeouts';
import { isBusyPhase, isStoppablePhase, normalizePhase, type RecordingPhase, type UploadJob } from '../shared/recording';

const L = makeLogger('background');
const RECORDER_TAB_CLEANUP_DELAY_MS = 15_000;

export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;
  private lastKnownPhase: RecordingPhase = 'idle';
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((reason?: unknown) => void) | null = null;
  /** Set while an intentional close+recreate is in flight so we keep the pending ready promise. */
  private recreating = false;
  private runtimeTransitioning = false;
  private recorderTabId: number | null = null;
  private recorderTabCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  public onStateChanged?: OffscreenStateListener;
  public onSaveRequested?: OffscreenSaveListener;
  public onUploadJobChanged?: OffscreenUploadListener;
  /** Ids of background upload jobs still uploading (ADR-0004). Keeps the runtime
   *  "busy" — defers update-teardown / recorder-tab cleanup — while a decoupled
   *  upload drains, even though the recording phase is idle. */
  private readonly activeUploadJobs = new Set<string>();

  private readonly rpcClient = createPortRpcClient(() => this.port, { timeoutMs: TIMEOUTS.RPC_MS });

  /** Initializes badge state before any offscreen connection exists. */
  constructor() {
    this.setBadge('idle');
  }

  /** Attaches the live offscreen port and starts listening for lifecycle messages. */
  attachPort(port: chrome.runtime.Port) {
    L.log('Offscreen connected');
    this.port = port;
    this.ready = false;

    port.onMessage.addListener((msg: OffscreenToBg | unknown) => this.onOffscreenMessage(msg));
    port.onDisconnect.addListener(() => {
      L.warn('Offscreen disconnected');
      // Don't clobber a newer port that may have attached during a recreate.
      if (this.port === port) this.port = null;
      this.ready = false;
      this.setBadge('idle');
      // During an intentional recreate, keep the in-flight ready promise so the
      // fresh document's READY can still resolve the original ensureReady() call.
      if (this.recreating || this.runtimeTransitioning) return;
      this.readyPromise = null;
      this.resolveReady = null;
      this.rejectReady = null;
    });
  }

  /** Syncs badge state from an already-known recording phase during hydration. */
  hydratePhase(phase: RecordingPhase) {
    this.lastKnownPhase = phase;
    this.setBadge(phase);
  }

  /** Returns the last phase reported by the offscreen document. */
  getRecordingStatus(): RecordingPhase {
    return this.lastKnownPhase;
  }

  /** Ensures the offscreen document exists and has completed its ready handshake. */
  async ensureReady(): Promise<void> {
    if (this.port && this.ready) return;

    const readyPromise = this.getOrCreateReadyPromise();

    const have = await this.hasOffscreenContext();
    if (!have) {
      L.log('Creating offscreen document…');
      await this.createDoc();
    } else {
      await requestOffscreenReconnect();
    }

    await withTimeout(readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Offscreen ready');
  }

  /**
   * Replaces the offscreen document with the same recorder runtime hosted in a
   * normal extension tab. Chrome can scope a tab-capture stream ID to this tab,
   * which avoids versions where offscreen documents cannot consume the ID.
   */
  async ensureRecorderTabReady(): Promise<number> {
    if (this.recorderTabId != null && this.port && this.ready) {
      this.cancelRecorderTabCleanup();
      return this.recorderTabId;
    }

    this.cancelRecorderTabCleanup();
    this.runtimeTransitioning = true;
    this.ready = false;
    this.resetReadyPromise();
    const readyPromise = this.getOrCreateReadyPromise();

    try {
      try { this.port?.disconnect(); } catch {}
      this.port = null;
      await closeOffscreenDocument();
      await this.waitUntilOffscreenGone();
      await this.closeRecorderTab();

      const tab = await createRuntimeTab('offscreen.html?runtime=tab', { active: true });
      if (typeof tab.id !== 'number') {
        throw new Error('Chrome did not return an id for the recorder extension tab');
      }
      this.recorderTabId = tab.id;

      await withTimeout(readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Recorder extension tab ready');
      L.warn('Using normal extension tab runtime for tab capture compatibility', tab.id);
      return tab.id;
    } catch (error) {
      await this.closeRecorderTab();
      this.failReady(error);
      throw error;
    } finally {
      this.runtimeTransitioning = false;
    }
  }

  /** Creates the offscreen document with the media-capture reasons it requires. */
  private async createDoc(): Promise<void> {
    await createOffscreenDocument('offscreen.html', {
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder',
    });
  }

  /** The build identifier both contexts compare against; empty if unavailable. */
  private currentVersion(): string {
    return getBuildId();
  }

  /**
   * Closes a stale offscreen document and creates a fresh one. The pending
   * ready promise is preserved (see the disconnect guard) so the new document's
   * matching OFFSCREEN_READY resolves the in-flight ensureReady() call.
   */
  private async recreateStaleOffscreen(): Promise<void> {
    try {
      this.ready = false;
      try { this.port?.disconnect(); } catch {}
      this.port = null;
      await closeOffscreenDocument();
      // closeDocument can resolve a tick before Chrome stops listing the context;
      // wait until it's gone so createDocument doesn't throw "single offscreen document".
      await this.waitUntilOffscreenGone();
      await this.createDoc();
      L.log('Recreated offscreen document from current code; awaiting fresh READY');
      // The fresh document connects and posts a versioned READY, which resolves the
      // in-flight ensureReady() via the match branch in onOffscreenMessage().
    } catch (e) {
      L.error('Offscreen recreate after version mismatch failed', e);
      this.recreating = false;
      // Fail the in-flight ensureReady() fast. The stale doc is already closed, so the
      // next start creates a fresh offscreen instead of re-hitting the mismatch loop.
      this.failReady(e);
    }
  }

  /** Polls until Chrome reports no offscreen document, bounded by maxMs. */
  private async waitUntilOffscreenGone(maxMs = 1_500): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      if (!(await this.hasOffscreenContext())) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Rejects and clears the pending ready promise so ensureReady() fails fast. */
  private failReady(reason: unknown): void {
    this.rejectReady?.(reason);
    this.rejectReady = null;
    this.resolveReady = null;
    this.readyPromise = null;
  }

  /**
   * Discards any existing offscreen document so the next recording uses fresh code.
   * Refuses while a recording or upload is in flight (returns false) so an update
   * can never tear down active work; the caller defers the refresh in that case.
   */
  async closeForUpdate(): Promise<boolean> {
    // ADR-0004: a decoupled upload keeps the runtime busy even at an idle phase,
    // so an update can never tear down the offscreen mid-upload.
    if (isBusyPhase(this.lastKnownPhase) || this.activeUploadJobs.size > 0) {
      L.log('Update arrived during active work; deferring offscreen refresh');
      return false;
    }
    this.runtimeTransitioning = true;
    this.ready = false;
    this.cancelRecorderTabCleanup();
    try { this.port?.disconnect(); } catch {}
    this.port = null;
    await closeOffscreenDocument();
    await this.closeRecorderTab();
    this.runtimeTransitioning = false;
    this.resetReadyPromise();
    L.log('Discarded stale offscreen document after extension update');
    return true;
  }

  /** Sends an RPC command across the offscreen port once the document is connected. */
  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    if (msg.type === 'OFFSCREEN_START') {
      this.cancelRecorderTabCleanup();
    }
    return await this.rpcClient<BgToOffscreenRpc, TRes>(msg);
  }

  /** Best-effort stop request used when Chrome is about to suspend the worker. */
  async stopIfPossibleOnSuspend(): Promise<void> {
    try {
      if (this.port && isStoppablePhase(this.lastKnownPhase)) {
        await this.rpc({ type: 'OFFSCREEN_STOP' });
      }
    } catch {}
    this.setBadge('idle');
  }

  /** Asks offscreen to revoke a blob URL and optionally clean up the related OPFS file. */
  revokeBlobUrl(blobUrl: string, opfsFilename?: string) {
    try {
      this.port?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl, opfsFilename });
    } catch {}
  }

  /** Resolves the pending ready promise after OFFSCREEN_READY arrives. */
  private signalReady() {
    this.resolveReady?.();
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
  }

  private getOrCreateReadyPromise(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
    }
    return this.readyPromise;
  }

  private resetReadyPromise(): void {
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private cancelRecorderTabCleanup(): void {
    if (this.recorderTabCleanupTimer == null) return;
    clearTimeout(this.recorderTabCleanupTimer);
    this.recorderTabCleanupTimer = null;
  }

  private scheduleRecorderTabCleanup(): void {
    if (this.recorderTabId == null) return;
    this.cancelRecorderTabCleanup();
    this.recorderTabCleanupTimer = setTimeout(() => {
      this.recorderTabCleanupTimer = null;
      // Keep the recorder runtime alive while a decoupled upload is draining (ADR-0004).
      if (this.lastKnownPhase !== 'idle' || this.activeUploadJobs.size > 0) return;
      void this.closeRecorderTab();
    }, RECORDER_TAB_CLEANUP_DELAY_MS);
  }

  private async closeRecorderTab(): Promise<void> {
    this.cancelRecorderTabCleanup();
    const tabId = this.recorderTabId;
    this.recorderTabId = null;
    if (tabId == null) return;
    try {
      await removeTab(tabId);
    } catch {
      // The tab may already have been closed manually or with its browser window.
    }
  }

  /** Routes validated offscreen messages into readiness, phase, and save handlers. */
  private onOffscreenMessage(msg: unknown) {
    if (!isOffscreenToBgMessage(msg)) return;

    if (msg.type === 'OFFSCREEN_READY') {
      const expected = this.currentVersion();
      if (expected && msg.version !== expected && !this.recreating) {
        this.recreating = true;
        L.warn(
          `Offscreen version mismatch (offscreen=${msg.version ?? 'none'}, extension=${expected}); recreating offscreen`
        );
        void this.recreateStaleOffscreen();
        return;
      }
      this.recreating = false;
      this.ready = true;
      this.signalReady();
      L.log('Offscreen is READY (Port)');
      return;
    }

    if (msg.type === 'OFFSCREEN_STATE') {
      const phase = normalizePhase(msg.phase);
      this.lastKnownPhase = phase;
      this.setBadge(phase);
      if (phase === 'idle') this.scheduleRecorderTabCleanup();
      else this.cancelRecorderTabCleanup();
      this.onStateChanged?.({ ...msg, phase });
      return;
    }

    if (msg.type === 'OFFSCREEN_UPLOAD_STATE') {
      // ADR-0004: a background upload job changed. Track in-flight ids so the
      // runtime stays "busy" while it drains, refresh the badge, and forward the
      // job so the session can persist it for the popup.
      if (msg.job.status === 'uploading') this.activeUploadJobs.add(msg.job.id);
      else this.activeUploadJobs.delete(msg.job.id);
      if (this.activeUploadJobs.size > 0) this.cancelRecorderTabCleanup();
      this.setBadge(this.lastKnownPhase);
      this.onUploadJobChanged?.(msg.job);
      return;
    }

    if (msg.type === 'OFFSCREEN_SAVE') {
      this.onSaveRequested?.(msg);
    }
  }

  /** Updates the extension action badge to reflect the last known runtime phase. */
  private setBadge(phase: RecordingPhase) {
    const text =
      phase === 'failed'
        ? 'ERR'
        : phase === 'idle'
          ? // ADR-0004: a decoupled upload can still be draining while idle.
            this.activeUploadJobs.size > 0 ? 'UP' : ''
          : 'REC';
    void setActionBadgeText(text);
  }

  /** Checks whether Chrome already has an offscreen document for this extension. */
  private async hasOffscreenContext(): Promise<boolean> {
    return await hasOffscreenDocument();
  }
}
