import { sleep } from '../shared/async';
import { makeLogger } from '../shared/logger';
import { createPortRpcClient } from '../shared/rpc';
import type { BgToOffscreenRpc, OffscreenToBg } from '../shared/protocol';

const L = makeLogger('background');

export class OffscreenManager {
  private port: chrome.runtime.Port | null = null;
  private ready = false;

  private lastKnownRecording = false;

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
      this.setBadge(false);
    });
  }

  getRecordingStatus(): boolean {
    return this.lastKnownRecording;
  }

  async ensureReady(): Promise<void> {
    const have = await this.hasOffscreenContext();
    if (!have) {
      L.log('Creating offscreen document…');
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'] as any,
        justification: 'Record tab audio+video in offscreen using MediaRecorder',
      });
    }

    // Wait for the offscreen script to signal it is ready
    for (let i = 0; i < 10 && !(this.port && this.ready); i++) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
        if (res?.ok) { L.log('Offscreen responded to PING'); break; }
      } catch {}
      await sleep(100);
    }

    if (!(this.port && this.ready)) {
      try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }); } catch {}
    }

    for (let i = 0; i < 50; i++) {
      if (this.port && this.ready) return;
      await sleep(100);
    }

    throw new Error('Offscreen did not become ready');
  }

  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    const client = createPortRpcClient(() => this.port, { timeoutMs: 15_000 });
    return await client<BgToOffscreenRpc, TRes>(msg);
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

  private onOffscreenMessage(msg: any) {
    if (msg?.type === 'OFFSCREEN_READY') {
      this.ready = true;
      L.log('Offscreen is READY (Port)');
      return;
    }

    if (msg?.type === 'RECORDING_STATE') {
      this.lastKnownRecording = !!msg.recording;
      this.setBadge(this.lastKnownRecording);
      chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: this.lastKnownRecording }).catch(() => {});
      return;
    }

    if (msg?.type === 'OFFSCREEN_SAVE') {
      const filename =
        (typeof msg.filename === 'string' && msg.filename.trim())
          ? msg.filename
          : `google-meet-recording-${Date.now()}.webm`;

      const blobUrl = msg.blobUrl as string | undefined;
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
          try { this.port?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl }); } catch {}
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
