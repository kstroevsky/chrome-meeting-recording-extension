/**
 * @file offscreen/RecorderEngine.ts
 *
 * Core recording logic. Captures tab audio+video and microphone audio
 * using the MediaRecorder API, then hands finished blobs back to the
 * Offscreen layer for download via Background.
 *
 * This class is intentionally decoupled from Chrome extension APIs:
 * all extension I/O (port messages, storage) is injected via `deps`.
 * This makes the engine independently testable with mock callbacks.
 *
 * AudioPlaybackBridge (private inner class):
 *   When Chrome captures a tab stream, it can suppress local playback so
 *   the user goes deaf during recording. The bridge re-routes captured tab
 *   audio back to speakers via an AudioContext to prevent this.
 *
 * @see src/offscreen.ts        — wires the deps and handles Port RPC
 * @see src/shared/timeouts.ts — GUM_MS, RECORDER_START_MS constants
 */

import { withTimeout } from '../shared/async';
import { TIMEOUTS } from '../shared/timeouts';

type RecordingStateExtra = Record<string, any> | undefined;

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;

  /** Send state updates to background/popup */
  notifyState: (recording: boolean, extra?: RecordingStateExtra) => void;

  /** Ask background to download a blob via blob URL */
  requestSave: (filename: string, blobUrl: string) => void;

  /**
   * Whether to capture and record the local microphone alongside tab audio.
   * Defaults to true. Set to false to record tab-only (no mic track).
   */
  enableMicMix?: boolean;
};

type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';

/**
 * State machine:
 *
 *   idle ──startFromStreamId()──▶ starting ──onstart event──▶ recording
 *    ▲                                                              │
 *    └───────onRecorderStopped() (activeRecorders === 0)──◀──stop()──▶ stopping
 *
 * isRecording() returns true for: starting, recording, stopping
 */
export class RecorderEngine {
  private deps: RecorderEngineDeps;

  private state: EngineState = 'idle';
  private activeRecorders = 0;

  private tabRecorder: MediaRecorder | null = null;
  private micRecorder: MediaRecorder | null = null;

  private tabChunks: BlobPart[] = [];
  private micChunks: BlobPart[] = [];

  private tabStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;

  private suffix = 'google-meet';

  private playback: AudioPlaybackBridge | null = null;

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting' || this.state === 'stopping';
  }

  async startFromStreamId(streamId: string): Promise<void> {
    if (this.isRecording()) {
      this.deps.log('Already recording; ignoring start');
      return;
    }

    this.state = 'starting';
    this.resetRunState();

    const baseStream = await this.captureWithStreamId(streamId);
    this.tabStream = baseStream;

    this.assertVideoTrack(baseStream);

    // Some Chrome configs suppress local audio playback when capturing tab audio.
    await this.ensureAudiblePlaybackIfSuppressed(baseStream);

    // Determine suffix (best-effort)
    this.suffix = await this.inferSuffixFromActiveTab().catch(() => 'google-meet');

    // Setup + start recorders
    const tabStarted = this.startTabRecorder(baseStream);
    void this.tryStartMicRecorder().catch((e) => this.deps.warn('Mic recorder start failed', e));

    // Wait only for TAB recorder to confirm start (matches previous behavior)
    await tabStarted;

    this.state = 'recording';
  }

  stop(): void {
    if (!this.tabRecorder || !this.isRecording()) {
      this.deps.warn('Stop called but not recording');
      throw new Error('Not currently recording');
    }

    this.state = 'stopping';

    try { this.tabRecorder.stop(); } catch (e) { this.deps.error('Tab stop error', e); throw e; }
    try { this.micRecorder?.stop(); } catch (e) { this.deps.error('Mic stop error', e); }

    this.playback?.stop();
    this.playback = null;
  }

  revokeBlobUrl(blobUrl: string) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  // -------------------------
  // Capture + track assertions
  // -------------------------

  private makeConstraints(streamId: string, source: 'tab' | 'desktop'): MediaStreamConstraints {
    const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any;
    return {
      audio: {
        mandatory,
        optional: [{ googDisableLocalEcho: false }],
      } as any,
      video: {
        mandatory: {
          ...mandatory,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      } as any,
    };
  }

  private async captureWithStreamId(streamId: string): Promise<MediaStream> {
    this.deps.log(`Attempting getUserMedia with streamId ${streamId} source=tab`);
    try {
      return await withTimeout(
        navigator.mediaDevices.getUserMedia(this.makeConstraints(streamId, 'tab')),
        TIMEOUTS.GUM_MS,
        'tab getUserMedia'
      );
    } catch (e1: any) {
      this.deps.warn('[gUM] failed for chromeMediaSource=tab:', e1?.name || e1, e1?.message || e1);
    }

    this.deps.log(`Attempting getUserMedia with streamId ${streamId} source=desktop`);
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(this.makeConstraints(streamId, 'desktop')),
      TIMEOUTS.GUM_MS,
      'desktop getUserMedia'
    );
  }

  private assertVideoTrack(stream: MediaStream) {
    const v = stream.getVideoTracks();
    if (!v.length) throw new Error('No video track in captured stream');
  }

  private async ensureAudiblePlaybackIfSuppressed(stream: MediaStream) {
    const rawAudio = stream.getAudioTracks()[0];

    this.deps.log('getUserMedia() tracks:', {
      audioCount: stream.getAudioTracks().length,
      videoCount: stream.getVideoTracks().length,
      audioMuted: rawAudio?.muted,
      audioEnabled: rawAudio?.enabled,
    });

    // Force-enable audio track
    stream.getAudioTracks().forEach((t) => { try { t.enabled = true; } catch {} });

    if (!rawAudio) {
      this.deps.warn('WARNING: tab stream has NO audio track — tab recording will be silent');
      this.deps.notifyState(false, { warning: 'NO_TAB_AUDIO' });
      return;
    }

    // Heuristic: tab capture frequently suppresses local playback.
    const settings = rawAudio.getSettings?.();
    const suppress = (settings as any)?.suppressLocalAudioPlayback;
    if (suppress ?? true) {
      this.playback = new AudioPlaybackBridge(this.deps);
      await this.playback.start(rawAudio);
    }
  }

  // -------------------------
  // Recorder creation + wiring
  // -------------------------

  private getVideoMime(): string {
    return MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
  }

  private getAudioMime(): string {
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
  }

  private startTabRecorder(baseStream: MediaStream): Promise<void> {
    this.tabChunks = [];
    const mime = this.getVideoMime();

    const recorder = new MediaRecorder(baseStream, {
      mimeType: mime,
      videoBitsPerSecond: 3_000_000,
      audioBitsPerSecond: 128_000,
    });
    this.tabRecorder = recorder;

    // Stop if captured video track ends (tab closed / navigation / capture ended)
    baseStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Video track ended');
      if (this.tabRecorder && this.isRecording()) { try { this.tabRecorder.stop(); } catch {} }
      if (this.micRecorder && this.isRecording()) { try { this.micRecorder.stop(); } catch {} }
    });

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) this.tabChunks.push(e.data);
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Tab MediaRecorder error', e);
      this.safeStopStream(this.tabStream);
      if (this.micRecorder && this.micRecorder.state !== 'inactive') {
        try { this.micRecorder.stop(); } catch {}
      }
      this.onRecorderStopped(); // was started? we handle via started flag below
      this.tabRecorder = null;
      this.deps.notifyState(false);
    };

    recorder.onstop = () => {
      try {
        const filename = `google-meet-recording-${this.suffix}-${Date.now()}.webm`;
        this.saveChunksToFile(this.tabChunks, mime, filename);
      } catch (e) {
        this.deps.error('Tab finalize/save failed', e);
      } finally {
        this.tabRecorder = null;
        this.tabChunks = [];
        this.onRecorderStopped();
      }
    };

    return new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Tab MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        this.onRecorderStarted();
        this.deps.log('Tab MediaRecorder started');
        resolve();
      };

      // Start with timeslice (kept from original behavior)
      recorder.start(1000);
    });
  }

  private async tryStartMicRecorder(): Promise<void> {
    const mic = await this.maybeGetMicStream();
    if (!mic?.getAudioTracks().length) {
      mic?.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      this.deps.log('Mic stream unavailable; continuing with tab-only recording');
      return;
    }

    this.micStream = mic;
    this.micChunks = [];

    const mime = this.getAudioMime();
    const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 128_000 });
    this.micRecorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) this.micChunks.push(e.data);
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Mic MediaRecorder error', e);
      this.safeStopStream(this.micStream);
      this.micRecorder = null;
      this.micStream = null;
      this.onRecorderStopped();
    };

    recorder.onstop = () => {
      try {
        const filename = `google-meet-mic-${this.suffix}-${Date.now()}.webm`;
        this.saveChunksToFile(this.micChunks, mime, filename);
      } catch (e) {
        this.deps.error('Mic finalize/save failed', e);
      } finally {
        this.micRecorder = null;
        this.micChunks = [];
        this.onRecorderStopped();
      }
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Mic MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        this.onRecorderStarted();
        this.deps.log('Mic MediaRecorder started');
        resolve();
      };

      recorder.start(1000);
    });
  }

  private async maybeGetMicStream(): Promise<MediaStream | null> {
    if (!this.deps.enableMicMix) return null;

    try {
      const mic = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        TIMEOUTS.GUM_MS,
        'mic getUserMedia'
      );

      const t = mic.getAudioTracks()[0];
      this.deps.log('mic stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled);

      return mic;
    } catch (e) {
      this.deps.warn('mic getUserMedia failed (continuing without mic):', e);
      return null;
    }
  }

  private saveChunksToFile(chunks: BlobPart[], mime: string, filename: string) {
    const blob = new Blob(chunks, { type: mime });
    this.deps.log('Finalizing', filename, 'chunks =', chunks.length, 'blob.size =', blob.size);

    const blobUrl = URL.createObjectURL(blob);
    this.deps.requestSave(filename, blobUrl);
  }

  // -------------------------
  // State + cleanup management
  // -------------------------

  private onRecorderStarted() {
    if (this.activeRecorders === 0) this.deps.notifyState(true);
    this.activeRecorders += 1;
  }

  private onRecorderStopped() {
    this.activeRecorders = Math.max(0, this.activeRecorders - 1);

    if (this.activeRecorders === 0) {
      this.state = 'idle';
      this.deps.notifyState(false);
      this.safeStopStream(this.tabStream);
      this.safeStopStream(this.micStream);
      this.tabStream = null;
      this.micStream = null;
    }
  }

  private safeStopStream(s: MediaStream | null) {
    try { s?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  private resetRunState() {
    this.activeRecorders = 0;
    this.tabRecorder = null;
    this.micRecorder = null;
    this.tabChunks = [];
    this.micChunks = [];
    this.safeStopStream(this.tabStream);
    this.safeStopStream(this.micStream);
    this.tabStream = null;
    this.micStream = null;
    this.playback?.stop();
    this.playback = null;
    this.suffix = 'google-meet';
  }

  private async inferSuffixFromActiveTab(): Promise<string> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url || null;

    try {
      if (!url) return 'google-meet';
      const u = new URL(url);
      const last = u.pathname.split('/').pop() || 'google-meet';
      return last;
    } catch {
      return 'google-meet';
    }
  }
}

class AudioPlaybackBridge {
  private deps: RecorderEngineDeps;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  async start(track: MediaStreamTrack): Promise<void> {
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new AC();
      this.ctx = ctx;

      await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      this.source = src;

      src.connect(ctx.destination);
      this.deps.log('Re-routed captured tab audio back to speakers');
    } catch (e) {
      this.deps.warn('Audio playback bridge failed (non-fatal)', e);
      this.stop();
    }
  }

  stop() {
    try { this.source?.disconnect(); } catch {}
    this.source = null;

    try { this.ctx?.close(); } catch {}
    this.ctx = null;
  }
}
