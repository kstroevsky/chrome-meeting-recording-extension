/**
 * @file offscreen/RecorderEngine.ts
 *
 * Core recording logic. Captures tab audio+video and microphone audio
 * using the MediaRecorder API, and streams the finished blobs to a specified
 * `StorageTarget` (e.g. OPFS local disk or Google Drive cloud).
 *
 * This class is intentionally decoupled from Chrome extension APIs:
 * all extension I/O (port messages, storage targets) is injected via `deps`.
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

export interface StorageTarget {
  /** Called for each MediaRecorder ondataavailable chunk. May be called concurrently. */
  write(chunk: Blob): Promise<void>;
  /** Called once after MediaRecorder.onstop fires. Must finalise/flush any buffered data. */
  close(): Promise<void>;
}

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;

  /** Send state updates to background/popup */
  notifyState: (recording: boolean, extra?: RecordingStateExtra) => void;

  /** Ask background to download a blob via blob URL (used only for legacy memory fallback) */
  requestSave: (filename: string, blobUrl: string) => void;

  /**
   * Whether to capture and record the local microphone alongside tab audio.
   * Defaults to true. Set to false to record tab-only (no mic track).
   */
  enableMicMix?: boolean;

  /**
   * Optional streaming storage backend (e.g., OPFS or Google Drive).
   * When provided: chunks are streamed directly by the target instead of buffering in RAM.
   * When absent: legacy in-memory blob path is used (for dev/testing).
   */
  openTarget?: (filename: string) => Promise<StorageTarget>;
};

type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';
type StartOptions = { recordSelfVideo?: boolean };

function describeMediaError(err: unknown): string {
  const e = err as any;
  const name = e?.name || 'Error';
  const message = e?.message || String(e);
  const constraint = e?.constraint ? ` constraint=${e.constraint}` : '';
  return `${name}: ${message}${constraint}`;
}

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
  private selfVideoRecorder: MediaRecorder | null = null;

  private tabChunks: BlobPart[] = [];
  private micChunks: BlobPart[] = [];
  private selfVideoChunks: BlobPart[] = [];

  private tabStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private selfVideoStream: MediaStream | null = null;

  private suffix = 'google-meet';
  private recordSelfVideo = false;

  private playback: AudioPlaybackBridge | null = null;

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting' || this.state === 'stopping';
  }

  async startFromStreamId(streamId: string, options: StartOptions = {}): Promise<void> {
    if (this.isRecording()) {
      this.deps.log('Already recording; ignoring start');
      return;
    }

    this.state = 'starting';
    this.resetRunState();
    this.recordSelfVideo = !!options.recordSelfVideo;

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
    if (this.recordSelfVideo) {
      void this.tryStartSelfVideoRecorder().catch((e) =>
        this.deps.warn('Self video recorder start failed (continuing without camera stream)', e)
      );
    }

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
    try { this.selfVideoRecorder?.stop(); } catch (e) { this.deps.error('Self video stop error', e); }

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
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'))
      return 'video/webm;codecs=vp9,opus';
    return MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
  }

  private getVideoOnlyMime(): string {
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) return 'video/webm;codecs=vp9';
    return MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
  }

  private getAudioMime(): string {
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
  }

  private async startTabRecorder(baseStream: MediaStream): Promise<void> {
    this.tabChunks = [];
    const mime = this.getVideoMime();
    let started = false;

    const recorder = new MediaRecorder(baseStream, {
      mimeType: mime,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });
    this.tabRecorder = recorder;
    
    const filename = `google-meet-recording-${this.suffix}-${Date.now()}.webm`;
    let target: StorageTarget | null = null;
    if (this.deps.openTarget) {
      try {
        target = await this.deps.openTarget(filename);
      } catch (e) {
        this.deps.warn('Failed to open storage target, falling back to RAM buffer', e);
      }
    }

    // Stop if captured video track ends (tab closed / navigation / capture ended)
    baseStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Video track ended');
      if (this.tabRecorder && this.isRecording()) { try { this.tabRecorder.stop(); } catch {} }
      if (this.micRecorder && this.isRecording()) { try { this.micRecorder.stop(); } catch {} }
      if (this.selfVideoRecorder && this.isRecording()) { try { this.selfVideoRecorder.stop(); } catch {} }
    });

    recorder.ondataavailable = async (e: BlobEvent) => {
      if (!e.data?.size) return;
      if (target) {
        await target.write(e.data).catch(err => this.deps.error('Target write error', err));
      } else {
        this.tabChunks.push(e.data);
      }
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Tab MediaRecorder error', e);
      this.safeStopStream(this.tabStream);
      if (this.micRecorder && this.micRecorder.state !== 'inactive') {
        try { this.micRecorder.stop(); } catch {}
      }
      if (this.selfVideoRecorder && this.selfVideoRecorder.state !== 'inactive') {
        try { this.selfVideoRecorder.stop(); } catch {}
      }
      if (started) this.onRecorderStopped();
      this.tabRecorder = null;
      if (target) {
        target.close().catch(err => this.deps.error('Target finalisation failed on error', err));
      }
      this.deps.notifyState(false);
    };

    recorder.onstop = async () => {
      try {
        if (target) {
          await target.close(); // Target handles its own file finalisation
        } else {
          this.saveChunksToFileLegacy(this.tabChunks, mime, filename);
        }
      } catch (e) {
        this.deps.error('Tab finalize/save failed', e);
      } finally {
        this.tabRecorder = null;
        this.tabChunks = [];
        if (started) this.onRecorderStopped();
      }
    };

    return new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Tab MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        started = true;
        this.onRecorderStarted();
        this.deps.log('Tab MediaRecorder started');
        resolve();
      };

      // Start with timeslice to ensure continuous chunking
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
    let started = false;
    const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 96_000 });
    this.micRecorder = recorder;
    
    const filename = `google-meet-mic-${this.suffix}-${Date.now()}.webm`;
    let target: StorageTarget | null = null;
    if (this.deps.openTarget) {
      try {
        target = await this.deps.openTarget(filename);
      } catch (e) {
        this.deps.warn('Failed to open mic storage target, falling back to RAM buffer', e);
      }
    }

    recorder.ondataavailable = async (e: BlobEvent) => {
      if (!e.data?.size) return;
      if (target) {
        await target.write(e.data).catch(err => this.deps.error('Mic Target write error', err));
      } else {
        this.micChunks.push(e.data);
      }
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Mic MediaRecorder error', e);
      this.safeStopStream(this.micStream);
      this.micRecorder = null;
      this.micStream = null;
      if (target) {
        target.close().catch(err => this.deps.error('Mic Target finalisation failed on error', err));
      }
      if (started) this.onRecorderStopped();
    };

    recorder.onstop = async () => {
      try {
        if (target) {
          await target.close(); // Target handles its own file finalisation
        } else {
          this.saveChunksToFileLegacy(this.micChunks, mime, filename);
        }
      } catch (e) {
        this.deps.error('Mic finalize/save failed', e);
      } finally {
        this.micRecorder = null;
        this.micChunks = [];
        if (started) this.onRecorderStopped();
      }
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Mic MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        started = true;
        this.onRecorderStarted();
        this.deps.log('Mic MediaRecorder started');
        resolve();
      };

      recorder.start(1000);
    });
  }

  private async tryStartSelfVideoRecorder(): Promise<void> {
    const selfVideo = await this.maybeGetSelfVideoStream();
    if (!selfVideo?.getVideoTracks().length) {
      selfVideo?.getTracks().forEach((t) => t.stop());
      this.selfVideoStream = null;
      this.deps.warn('Self video stream unavailable; continuing without camera recording');
      return;
    }

    this.selfVideoStream = selfVideo;
    this.selfVideoChunks = [];

    const mime = this.getVideoOnlyMime();
    let started = false;
    const recorder = new MediaRecorder(selfVideo, { mimeType: mime, videoBitsPerSecond: 1_000_000 });
    this.selfVideoRecorder = recorder;

    const filename = `google-meet-self-video-${this.suffix}-${Date.now()}.webm`;
    let target: StorageTarget | null = null;
    if (this.deps.openTarget) {
      try {
        target = await this.deps.openTarget(filename);
      } catch (e) {
        this.deps.warn('Failed to open self video storage target, falling back to RAM buffer', e);
      }
    }

    selfVideo.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Self video track ended');
      if (this.selfVideoRecorder && this.selfVideoRecorder.state !== 'inactive') {
        try { this.selfVideoRecorder.stop(); } catch {}
      }
    });

    recorder.ondataavailable = async (e: BlobEvent) => {
      if (!e.data?.size) return;
      if (target) {
        await target.write(e.data).catch(err => this.deps.error('Self video target write error', err));
      } else {
        this.selfVideoChunks.push(e.data);
      }
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Self video MediaRecorder error', e);
      this.safeStopStream(this.selfVideoStream);
      this.selfVideoRecorder = null;
      this.selfVideoStream = null;
      if (target) {
        target.close().catch(err => this.deps.error('Self video target finalisation failed on error', err));
      }
      if (started) this.onRecorderStopped();
    };

    recorder.onstop = async () => {
      try {
        if (target) {
          await target.close();
        } else {
          this.saveChunksToFileLegacy(this.selfVideoChunks, mime, filename);
        }
      } catch (e) {
        this.deps.error('Self video finalize/save failed', e);
      } finally {
        this.selfVideoRecorder = null;
        this.selfVideoChunks = [];
        if (started) this.onRecorderStopped();
      }
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Self video MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        started = true;
        this.onRecorderStarted();
        this.deps.log('Self video MediaRecorder started');
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

  private async maybeGetSelfVideoStream(): Promise<MediaStream | null> {
    if (!this.recordSelfVideo) return null;

    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        }),
        TIMEOUTS.GUM_MS,
        'self video getUserMedia'
      );

      const t = stream.getVideoTracks()[0];
      this.deps.log('self video stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled);
      return stream;
    } catch (e) {
      this.deps.warn(
        'self video getUserMedia failed (continuing without self video):',
        describeMediaError(e)
      );
      return null;
    }
  }

  private saveChunksToFileLegacy(chunks: BlobPart[], mime: string, filename: string) {
    const blob = new Blob(chunks, { type: mime });
    this.deps.log('Finalizing (legacy RAM Buffer)', filename, 'chunks =', chunks.length, 'blob.size =', blob.size);

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
      this.safeStopStream(this.selfVideoStream);
      this.tabStream = null;
      this.micStream = null;
      this.selfVideoStream = null;
    }
  }

  private safeStopStream(s: MediaStream | null) {
    try { s?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  private resetRunState() {
    this.activeRecorders = 0;
    this.tabRecorder = null;
    this.micRecorder = null;
    this.selfVideoRecorder = null;
    this.tabChunks = [];
    this.micChunks = [];
    this.selfVideoChunks = [];
    this.safeStopStream(this.tabStream);
    this.safeStopStream(this.micStream);
    this.safeStopStream(this.selfVideoStream);
    this.tabStream = null;
    this.micStream = null;
    this.selfVideoStream = null;
    this.playback?.stop();
    this.playback = null;
    this.suffix = 'google-meet';
    this.recordSelfVideo = false;
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
