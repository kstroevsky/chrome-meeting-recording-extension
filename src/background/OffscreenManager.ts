/**
 * @file background/OffscreenManager.ts
 *
 * Owns the offscreen document lifecycle and forwards offscreen state to the
 * popup/background UI layer.
 */
import { setActionBadgeText } from '../platform/chrome/action';
import {
  createOffscreenDocument,
  hasOffscreenDocument,
  requestOffscreenReconnect,
} from '../platform/chrome/offscreen';
import { withTimeout } from '../shared/async';
import { makeLogger } from '../shared/logger';
import { createPortRpcClient } from '../shared/rpc';
import type {
  BgToOffscreenRpc,
  OffscreenToBg,
} from '../shared/protocol';
import { isOffscreenToBgMessage } from '../shared/protocol';
import { TIMEOUTS } from '../shared/timeouts';
import type { RecordingPhase } from '../shared/recording';

const L = makeLogger('background');

export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;
  private lastKnownPhase: RecordingPhase = 'idle';
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  public onStateChanged?: (msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_STATE' }>) => void;
  public onSaveRequested?: (msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_SAVE' }>) => void;

  private readonly rpcClient = createPortRpcClient(() => this.port, { timeoutMs: TIMEOUTS.RPC_MS });

  constructor() {
    this.setBadge('idle');
  }

  attachPort(port: chrome.runtime.Port) {
    L.log('Offscreen connected');
    this.port = port;
    this.ready = false;

    port.onMessage.addListener((msg: OffscreenToBg | unknown) => this.onOffscreenMessage(msg));
    port.onDisconnect.addListener(() => {
      L.warn('Offscreen disconnected');
      this.port = null;
      this.ready = false;
      this.readyPromise = null;
      this.resolveReady = null;
      this.setBadge('idle');
    });
  }

  hydratePhase(phase: RecordingPhase) {
    this.lastKnownPhase = phase;
    this.setBadge(phase);
  }

  getRecordingStatus(): RecordingPhase {
    return this.lastKnownPhase;
  }

  async ensureReady(): Promise<void> {
    if (this.port && this.ready) return;

    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.resolveReady = resolve;
      });
    }

    const have = await this.hasOffscreenContext();
    if (!have) {
      L.log('Creating offscreen document…');
      await createOffscreenDocument('offscreen.html', {
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
        justification: 'Record tab audio+video in offscreen using MediaRecorder',
      });
    } else {
      await requestOffscreenReconnect();
    }

    await withTimeout(this.readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Offscreen ready');
  }

  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    return await this.rpcClient<BgToOffscreenRpc, TRes>(msg);
  }

  async stopIfPossibleOnSuspend(): Promise<void> {
    try {
      if (this.port && (this.lastKnownPhase === 'starting' || this.lastKnownPhase === 'recording' || this.lastKnownPhase === 'stopping')) {
        await this.rpc({ type: 'OFFSCREEN_STOP' });
      }
    } catch {}
    this.setBadge('idle');
  }

  revokeBlobUrl(blobUrl: string, opfsFilename?: string) {
    try {
      this.port?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl, opfsFilename });
    } catch {}
  }

  private signalReady() {
    this.resolveReady?.();
    this.resolveReady = null;
    this.readyPromise = null;
  }

  private onOffscreenMessage(msg: unknown) {
    if (!isOffscreenToBgMessage(msg)) return;

    if (msg.type === 'OFFSCREEN_READY') {
      this.ready = true;
      this.signalReady();
      L.log('Offscreen is READY (Port)');
      return;
    }

    if (msg.type === 'OFFSCREEN_STATE') {
      const phase =
        msg.phase === 'starting'
        || msg.phase === 'recording'
        || msg.phase === 'stopping'
        || msg.phase === 'uploading'
        || msg.phase === 'failed'
          ? msg.phase
          : 'idle';
      this.lastKnownPhase = phase;
      this.setBadge(phase);
      this.onStateChanged?.({ ...msg, phase });
      return;
    }

    if (msg.type === 'OFFSCREEN_SAVE') {
      this.onSaveRequested?.(msg);
    }
  }

  private setBadge(phase: RecordingPhase) {
    const text =
      phase === 'uploading'
        ? 'UP'
        : phase === 'failed'
          ? 'ERR'
          : phase === 'idle'
            ? ''
            : 'REC';
    void setActionBadgeText(text);
  }

  private async hasOffscreenContext(): Promise<boolean> {
    return await hasOffscreenDocument();
  }
}
