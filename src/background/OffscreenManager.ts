/**
 * @file background/OffscreenManager.ts
 *
 * Owns the full lifecycle of the Offscreen document and the Port connection to it.
 *
 * Responsibilities:
 *   - Create the offscreen document when needed (ensureReady)
 *   - Wait for the offscreen script to signal readiness via Port
 *   - Proxy recording RPC calls (start/stop/status) over the Port
 *   - React to state events from offscreen (badge, downloads, popup forwarding)
 *
 * The "ready" handshake sequence:
 *   1. ensureReady() creates the offscreen HTML page if it doesn't exist,
 *      then arms a promise that will resolve when OFFSCREEN_READY arrives.
 *   2. The offscreen script loads and calls connectPort() automatically.
 *   3. connectPort() sends OFFSCREEN_READY via the Port.
 *   4. attachPort() receives OFFSCREEN_READY → calls signalReady() → resolves promise.
 *   5. ensureReady() races the promise against TIMEOUTS.READY_TIMEOUT_MS.
 *      No polling loops — resolves as soon as ready, fails fast if not.
 *
 * @see src/offscreen.ts        — the other end of the Port
 * @see src/shared/rpc.ts      — createPortRpcClient used by this.rpcClient
 * @see src/shared/timeouts.ts — timeout constants
 */
import { withTimeout } from '../shared/async';
import { makeLogger } from '../shared/logger';
import { createPortRpcClient } from '../shared/rpc';
import type { BgToOffscreenRpc, OffscreenToBg } from '../shared/protocol';
import { TIMEOUTS } from '../shared/timeouts';

const L = makeLogger('background');

export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;

  private lastKnownRecording = false;

  // --------------------
  // Ready signal (promise-based, replaces sleep-poll loops)
  // --------------------
  // A single deferred promise is armed in ensureReady() and resolved by
  // signalReady() when OFFSCREEN_READY arrives over the Port.
  // The promise is nulled after resolution so the next call to ensureReady()
  // creates a fresh deferred.
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  public onRecordingChanged?: (recording: boolean) => void;

  // --------------------
  // RPC client (created once; closure captures `this.port`)
  // --------------------
  // The closure `() => this.port` is re-evaluated on every call, so the client
  // always uses the current live port even after reconnects.
  private readonly rpcClient = createPortRpcClient(() => this.port, { timeoutMs: TIMEOUTS.RPC_MS });

  constructor() {
    // Keep badge in sync even if popup isn't open
    this.setBadge(false);
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
      // Discard any pending ready-promise so ensureReady() creates a new one
      this.readyPromise = null;
      this.resolveReady = null;
      this.setBadge(false);
    });
  }

  getRecordingStatus(): boolean {
    return this.lastKnownRecording;
  }

  async ensureReady(): Promise<void> {
    // Already live — nothing to do
    if (this.port && this.ready) return;

    // Arm the ready-promise before creating the document so we don't miss
    // a very fast OFFSCREEN_READY signal that arrives before the await below.
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>(resolve => { this.resolveReady = resolve; });
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
      // Already running but Port may have dropped — ask it to reconnect
      try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }); } catch {}
    }

    // Wait for the offscreen script to complete startup and signal OFFSCREEN_READY.
    // withTimeout ensures we never wait more than READY_TIMEOUT_MS, regardless of
    // how fast (or slow) the offscreen doc loads.
    await withTimeout(this.readyPromise, TIMEOUTS.READY_TIMEOUT_MS, 'Offscreen ready');
  }

  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    return await this.rpcClient<BgToOffscreenRpc, TRes>(msg);
  }

  async stopIfPossibleOnSuspend(): Promise<void> {
    try {
      if (this.port) await this.rpc({ type: 'OFFSCREEN_STOP' } as any);
    } catch {}
    this.setBadge(false);
  }

  // --------------------
  // Offscreen events
  // --------------------

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
      this.lastKnownRecording = !!msg.recording;
      this.setBadge(this.lastKnownRecording);
      chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: this.lastKnownRecording }).catch(() => {});
      this.onRecordingChanged?.(this.lastKnownRecording);
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
      chrome.downloads.download({ url: blobUrl, filename, saveAs: true }, () => {
        if (chrome.runtime.lastError) {
          L.warn('downloads.download error:', chrome.runtime.lastError.message);
        } else {
          chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename }).catch(() => {});
        }

        // Revoke later
        setTimeout(() => {
          try { this.port?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl, opfsFilename }); } catch {}
        }, 10_000);
      });

      return;
    }
  }

  private setBadge(recording: boolean) {
    chrome.action.setBadgeText({ text: recording ? 'REC' : '' }).catch?.(() => {});
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
