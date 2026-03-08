/**
 * @file background/OffscreenManager.ts
 *
 * Owns the offscreen document lifecycle and forwards offscreen state to the
 * popup/background UI layer.
 */
import { withTimeout } from '../shared/async';
import { makeLogger } from '../shared/logger';
import { createPortRpcClient } from '../shared/rpc';
import type {
  BgToOffscreenRpc,
  OffscreenToBg,
  RecordingPhase,
  RecordingRunConfig,
} from '../shared/protocol';
import { TIMEOUTS } from '../shared/timeouts';

const L = makeLogger('background');

export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;
  private lastKnownPhase: RecordingPhase = 'idle';
  private activeRunConfig: RecordingRunConfig | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  public onPhaseChanged?: (phase: RecordingPhase) => void;

  private readonly rpcClient = createPortRpcClient(() => this.port, { timeoutMs: TIMEOUTS.RPC_MS });

  constructor() {
    this.setBadge('idle');
  }

  attachPort(port: chrome.runtime.Port) {
    L.log('Offscreen connected');
    this.port = port;
    this.ready = false;

    port.onMessage.addListener((msg: OffscreenToBg | any) => this.onOffscreenMessage(msg));
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

  setRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
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
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'] as any,
        justification: 'Record tab audio+video in offscreen using MediaRecorder',
      });
    } else {
      try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }); } catch {}
    }

    await withTimeout(this.readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Offscreen ready');
  }

  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    return await this.rpcClient<BgToOffscreenRpc, TRes>(msg);
  }

  async stopIfPossibleOnSuspend(): Promise<void> {
    try {
      if (this.port && this.lastKnownPhase === 'recording') {
        await this.rpc({ type: 'OFFSCREEN_STOP' } as any);
      }
    } catch {}
    this.setBadge('idle');
  }

  private signalReady() {
    this.resolveReady?.();
    this.resolveReady = null;
    this.readyPromise = null;
  }

  private onOffscreenMessage(msg: any) {
    if (msg?.type === 'OFFSCREEN_READY') {
      this.ready = true;
      this.signalReady();
      L.log('Offscreen is READY (Port)');
      return;
    }

    if (msg?.type === 'RECORDING_STATE') {
      const phase = (msg.phase === 'recording' || msg.phase === 'uploading') ? msg.phase : 'idle';
      this.lastKnownPhase = phase;
      this.setBadge(phase);
      chrome.runtime.sendMessage({
        type: 'RECORDING_STATE',
        phase,
        uploadSummary: msg.uploadSummary,
        runConfig: phase === 'idle' ? undefined : (this.activeRunConfig ?? undefined),
      }).catch(() => {});
      this.onPhaseChanged?.(phase);
      return;
    }

    if (msg?.type === 'OFFSCREEN_SAVE') {
      const filename =
        (typeof msg.filename === 'string' && msg.filename.trim())
          ? msg.filename
          : `google-meet-recording-${Date.now()}.webm`;

      const blobUrl = msg.blobUrl as string | undefined;
      const opfsFilename = msg.opfsFilename as string | undefined;
      if (!blobUrl) return;

      L.log('Saving OFFSCREEN_SAVE via blobUrl', filename);
      chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, () => {
        const lastError = chrome.runtime.lastError?.message;
        const cleanupOpfsFilename = lastError ? undefined : opfsFilename;

        if (lastError) {
          L.warn('downloads.download error:', lastError);
          chrome.runtime
            .sendMessage({ type: 'RECORDING_SAVE_ERROR', filename, error: lastError })
            .catch(() => {});
        } else {
          chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename }).catch(() => {});
        }

        setTimeout(() => {
          try {
            this.port?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl, opfsFilename: cleanupOpfsFilename });
          } catch {}
        }, 10_000);
      });
    }
  }

  private setBadge(phase: RecordingPhase) {
    const text = phase === 'recording' ? 'REC' : phase === 'uploading' ? 'UP' : '';
    chrome.action.setBadgeText({ text }).catch?.(() => {});
  }

  private async hasOffscreenContext(): Promise<boolean> {
    try {
      const getContexts = (chrome.runtime as any).getContexts as
        | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
        | undefined;

      if (getContexts) {
        const ctx = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
        return Array.isArray(ctx) && ctx.length > 0;
      }
    } catch {}

    try {
      return !!(await (chrome.offscreen as any).hasDocument?.());
    } catch {
      return false;
    }
  }
}
