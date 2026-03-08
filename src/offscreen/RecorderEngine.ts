/**
 * @file offscreen/RecorderEngine.ts
 *
 * Core recording logic. Captures tab audio+video and optional microphone/self
 * video streams, writes chunks to local storage targets, and returns sealed
 * local artifacts once capture stops.
 */

import { withTimeout } from '../shared/async';
import { PERF_FLAGS, clamp, debugPerf, logPerf, nowMs, roundMs } from '../shared/perf';
import type { RecordingPhase, RecordingStream } from '../shared/protocol';
import { TIMEOUTS } from '../shared/timeouts';

type RecordingStateExtra = Record<string, any> | undefined;
type SelfVideoQuality = 'standard' | 'high';
type StartOptions = {
  recordSelfVideo?: boolean;
  selfVideoQuality?: SelfVideoQuality;
};

type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';
const CHUNK_TIMESLICE_MS = 2000;
const EXTENDED_CHUNK_TIMESLICE_MS = 4000;

export interface SealedStorageFile {
  filename: string;
  file: Blob;
  opfsFilename?: string;
  cleanup: () => Promise<void>;
}

export interface StorageTarget {
  write(chunk: Blob): Promise<void>;
  close(): Promise<SealedStorageFile | null>;
}

export type CompletedRecordingArtifact = {
  stream: RecordingStream;
  artifact: SealedStorageFile;
};

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
  notifyPhase: (phase: RecordingPhase, extra?: RecordingStateExtra) => void;
  enableMicMix?: boolean;
  openTarget?: (filename: string) => Promise<StorageTarget>;
};

function describeMediaError(err: unknown): string {
  const e = err as any;
  const name = e?.name || 'Error';
  const message = e?.message || String(e);
  const constraint = e?.constraint ? ` constraint=${e.constraint}` : '';
  const code = e?.code != null ? ` code=${e.code}` : '';
  return `${name}: ${message}${constraint}${code}`;
}

class InMemoryStorageTarget implements StorageTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;

  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
  ) {}

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory target is closed');
    this.chunks.push(chunk);
  }

  async close(): Promise<SealedStorageFile | null> {
    if (this.closed) return null;
    this.closed = true;
    if (!this.chunks.length) return null;

    const file = new File([new Blob(this.chunks, { type: this.mimeType })], this.filename, {
      type: this.mimeType,
    });

    return {
      filename: this.filename,
      file,
      cleanup: async () => {},
    };
  }
}

export class RecorderEngine {
  private readonly deps: RecorderEngineDeps;

  private state: EngineState = 'idle';
  private activeRecorders = 0;
  private runId = 0;

  private tabRecorder: MediaRecorder | null = null;
  private micRecorder: MediaRecorder | null = null;
  private selfVideoRecorder: MediaRecorder | null = null;

  private tabStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private selfVideoStream: MediaStream | null = null;

  private suffix = 'google-meet';
  private recordSelfVideo = false;
  private selfVideoQuality: SelfVideoQuality = 'standard';

  private playback: AudioPlaybackBridge | null = null;
  private stopPromise: Promise<CompletedRecordingArtifact[]> | null = null;
  private resolveStop: ((artifacts: CompletedRecordingArtifact[]) => void) | null = null;
  private finalizedArtifacts: CompletedRecordingArtifact[] = [];

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting' || this.state === 'stopping';
  }

  getActiveRecorderCount(): number {
    return this.activeRecorders;
  }

  getDebugState(): EngineState {
    return this.state;
  }

  async startFromStreamId(streamId: string, options: StartOptions = {}): Promise<void> {
    if (this.isRecording()) {
      this.deps.log('Already recording; ignoring start');
      return;
    }

    this.resetRunState();
    this.state = 'starting';
    this.runId += 1;
    const runId = this.runId;
    this.recordSelfVideo = !!options.recordSelfVideo;
    this.selfVideoQuality = options.selfVideoQuality === 'high' ? 'high' : 'standard';
    const runStartedAt = nowMs();

    try {
      const baseStream = await this.captureWithStreamId(streamId);
      this.tabStream = baseStream;
      this.assertVideoTrack(baseStream);
      await this.ensureAudiblePlaybackIfSuppressed(baseStream);
      this.suffix = await this.inferSuffixFromActiveTab().catch(() => 'google-meet');

      const tabStarted = this.startTabRecorder(baseStream, runStartedAt);
      void this.tryStartMicRecorder(runId, runStartedAt).catch((e) =>
        this.deps.warn('Mic recorder start failed', describeMediaError(e))
      );
      if (this.recordSelfVideo) {
        void this.tryStartSelfVideoRecorder(runId, runStartedAt).catch((e) =>
          this.deps.warn(
            'Self video recorder start failed (continuing without camera stream)',
            describeMediaError(e)
          )
        );
      }

      await tabStarted;
      if (this.runId === runId && this.state === 'starting') {
        this.state = 'recording';
      }
    } catch (e) {
      this.state = 'idle';
      this.resetRunState();
      throw e;
    }
  }

  stop(): Promise<CompletedRecordingArtifact[]> {
    if (!this.tabRecorder || !this.isRecording()) {
      this.deps.warn('Stop called but not recording');
      return Promise.resolve([]);
    }

    if (this.stopPromise) return this.stopPromise;

    this.state = 'stopping';
    this.stopPromise = new Promise<CompletedRecordingArtifact[]>((resolve) => {
      this.resolveStop = resolve;
    });

    try { this.tabRecorder.stop(); } catch (e) { this.deps.error('Tab stop error', describeMediaError(e)); throw e; }
    try { this.micRecorder?.stop(); } catch (e) { this.deps.error('Mic stop error', describeMediaError(e)); }
    try { this.selfVideoRecorder?.stop(); } catch (e) { this.deps.error('Self video stop error', describeMediaError(e)); }

    this.playback?.stop();
    this.playback = null;

    return this.stopPromise;
  }

  revokeBlobUrl(blobUrl: string) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

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
    if (!stream.getVideoTracks().length) throw new Error('No video track in captured stream');
  }

  private async ensureAudiblePlaybackIfSuppressed(stream: MediaStream) {
    const rawAudio = stream.getAudioTracks()[0];

    this.deps.log('getUserMedia() tracks:', {
      audioCount: stream.getAudioTracks().length,
      videoCount: stream.getVideoTracks().length,
      audioMuted: rawAudio?.muted,
      audioEnabled: rawAudio?.enabled,
    });

    stream.getAudioTracks().forEach((t) => { try { t.enabled = true; } catch {} });

    if (!rawAudio) {
      this.deps.warn('WARNING: tab stream has NO audio track — tab recording will be silent');
      return;
    }

    const settings = rawAudio.getSettings?.();
    const suppress = (settings as any)?.suppressLocalAudioPlayback;
    const shouldBridge =
      PERF_FLAGS.audioPlaybackBridgeMode === 'always'
        ? (suppress ?? true)
        : suppress === true;

    logPerf(this.deps.log, 'recorder', 'tab_audio_bridge_check', {
      mode: PERF_FLAGS.audioPlaybackBridgeMode,
      suppressLocalAudioPlayback: suppress,
      willBridge: shouldBridge,
    });

    if (shouldBridge) {
      this.playback = new AudioPlaybackBridge(this.deps);
      await this.playback.start(rawAudio);
    }
  }

  private getVideoMime(): string {
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
      return 'video/webm;codecs=vp8,opus';
    }
    return MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
  }

  private getVideoOnlyMime(): string {
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'video/webm;codecs=vp8';
    return MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
  }

  private getSelfVideoProfile(): { constraints: MediaTrackConstraints; defaultVideoBitsPerSecond: number } {
    if (this.selfVideoQuality === 'high') {
      return {
        constraints: {
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        defaultVideoBitsPerSecond: 2_500_000,
      };
    }

    return {
        constraints: {
          width: { ideal: 960, max: 960 },
          height: { ideal: 540, max: 540 },
          frameRate: { ideal: 24, max: 24 },
        },
        defaultVideoBitsPerSecond: 1_200_000,
      };
  }

  private getAudioMime(): string {
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
  }

  private async startTabRecorder(baseStream: MediaStream, runStartedAt: number): Promise<void> {
    const mime = this.getVideoMime();
    let started = false;
    const timesliceMs = this.getChunkTimesliceMs();

    const recorder = new MediaRecorder(baseStream, {
      mimeType: mime,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });
    this.tabRecorder = recorder;

    const filename = `google-meet-recording-${this.suffix}-${Date.now()}.webm`;
    const target = await this.openStorageTarget(filename, mime);

    const finalize = async (label: string) => {
      try {
        const artifact = await target.close();
        if (artifact) this.finalizedArtifacts.push({ stream: 'tab', artifact });
      } catch (e) {
        this.deps.error(`${label} finalize/save failed`, describeMediaError(e));
      } finally {
        this.tabRecorder = null;
        if (started) this.onRecorderStopped();
      }
    };

    baseStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Video track ended');
      if (this.tabRecorder && this.isRecording()) { try { this.tabRecorder.stop(); } catch {} }
      if (this.micRecorder && this.isRecording()) { try { this.micRecorder.stop(); } catch {} }
      if (this.selfVideoRecorder && this.isRecording()) { try { this.selfVideoRecorder.stop(); } catch {} }
    });

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data?.size) return;
      const writeStartedAt = nowMs();
      void target.write(e.data)
        .then(() => {
          debugPerf(this.deps.log, 'recorder', 'chunk_persisted', {
            stream: 'tab',
            chunkBytes: e.data.size,
            durationMs: roundMs(nowMs() - writeStartedAt),
          });
        })
        .catch((err) => this.deps.error('Target write error', describeMediaError(err)));
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
      void finalize('Tab');
    };

    recorder.onstop = () => {
      void finalize('Tab');
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Tab MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        started = true;
        this.onRecorderStarted();
        logPerf(this.deps.log, 'recorder', 'recorder_started', {
          stream: 'tab',
          latencyMs: roundMs(nowMs() - runStartedAt),
          mime,
          timesliceMs,
        });
        this.deps.log('Tab MediaRecorder started');
        resolve();
      };

      recorder.start(timesliceMs);
    });
  }

  private async tryStartMicRecorder(runId: number, runStartedAt: number): Promise<void> {
    const mic = await this.maybeGetMicStream();
    if (!mic?.getAudioTracks().length || this.runId !== runId || this.state === 'stopping' || this.state === 'idle') {
      mic?.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      if (mic?.getAudioTracks().length) {
        this.deps.log('Mic stream obtained after stop; discarding it');
      } else {
        this.deps.log('Mic stream unavailable; continuing with tab-only recording');
      }
      return;
    }

    this.micStream = mic;
    const mime = this.getAudioMime();
    let started = false;
    const timesliceMs = this.getChunkTimesliceMs();
    const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 96_000 });
    this.micRecorder = recorder;

    const filename = `google-meet-mic-${this.suffix}-${Date.now()}.webm`;
    const target = await this.openStorageTarget(filename, mime);

    const finalize = async (label: string) => {
      try {
        const artifact = await target.close();
        if (artifact) this.finalizedArtifacts.push({ stream: 'mic', artifact });
      } catch (e) {
        this.deps.error(`${label} finalize/save failed`, describeMediaError(e));
      } finally {
        this.micRecorder = null;
        this.micStream = null;
        if (started) this.onRecorderStopped();
      }
    };

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data?.size) return;
      const writeStartedAt = nowMs();
      void target.write(e.data)
        .then(() => {
          debugPerf(this.deps.log, 'recorder', 'chunk_persisted', {
            stream: 'mic',
            chunkBytes: e.data.size,
            durationMs: roundMs(nowMs() - writeStartedAt),
          });
        })
        .catch((err) => this.deps.error('Mic target write error', describeMediaError(err)));
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Mic MediaRecorder error', e);
      this.safeStopStream(this.micStream);
      void finalize('Mic');
    };

    recorder.onstop = () => {
      void finalize('Mic');
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
        logPerf(this.deps.log, 'recorder', 'recorder_started', {
          stream: 'mic',
          latencyMs: roundMs(nowMs() - runStartedAt),
          mime,
          timesliceMs,
        });
        this.deps.log('Mic MediaRecorder started');
        resolve();
      };

      recorder.start(timesliceMs);
    });
  }

  private async tryStartSelfVideoRecorder(runId: number, runStartedAt: number): Promise<void> {
    const selfVideo = await this.maybeGetSelfVideoStream();
    if (
      !selfVideo?.getVideoTracks().length ||
      this.runId !== runId ||
      this.state === 'stopping' ||
      this.state === 'idle'
    ) {
      selfVideo?.getTracks().forEach((t) => t.stop());
      this.selfVideoStream = null;
      if (selfVideo?.getVideoTracks().length) {
        this.deps.log('Self video stream obtained after stop; discarding it');
      } else {
        this.deps.warn('Self video stream unavailable; continuing without camera recording');
      }
      return;
    }

    this.selfVideoStream = selfVideo;
    const profile = this.getSelfVideoProfile();
    const mime = this.getVideoOnlyMime();
    let started = false;
    const timesliceMs = this.getChunkTimesliceMs();
    const track = selfVideo.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const videoBitsPerSecond = this.resolveSelfVideoBitrate(
      profile.defaultVideoBitsPerSecond,
      settings
    );
    try {
      if (track && 'contentHint' in track) (track as any).contentHint = 'motion';
    } catch {}

    const recorder = new MediaRecorder(selfVideo, {
      mimeType: mime,
      videoBitsPerSecond,
    });
    this.selfVideoRecorder = recorder;

    const filename = `google-meet-self-video-${this.suffix}-${Date.now()}.webm`;
    const target = await this.openStorageTarget(filename, mime);

    const finalize = async (label: string) => {
      try {
        const artifact = await target.close();
        if (artifact) this.finalizedArtifacts.push({ stream: 'selfVideo', artifact });
      } catch (e) {
        this.deps.error(`${label} finalize/save failed`, describeMediaError(e));
      } finally {
        this.selfVideoRecorder = null;
        this.selfVideoStream = null;
        if (started) this.onRecorderStopped();
      }
    };

    selfVideo.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Self video track ended');
      if (this.selfVideoRecorder && this.selfVideoRecorder.state !== 'inactive') {
        try { this.selfVideoRecorder.stop(); } catch {}
      }
    });

    recorder.ondataavailable = (e: BlobEvent) => {
      if (!e.data?.size) return;
      const writeStartedAt = nowMs();
      void target.write(e.data)
        .then(() => {
          debugPerf(this.deps.log, 'recorder', 'chunk_persisted', {
            stream: 'selfVideo',
            chunkBytes: e.data.size,
            durationMs: roundMs(nowMs() - writeStartedAt),
          });
        })
        .catch((err) => this.deps.error('Self video target write error', describeMediaError(err)));
    };

    recorder.onerror = (e: any) => {
      this.deps.error('Self video MediaRecorder error', e);
      this.safeStopStream(this.selfVideoStream);
      void finalize('Self video');
    };

    recorder.onstop = () => {
      void finalize('Self video');
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
        logPerf(this.deps.log, 'recorder', 'recorder_started', {
          stream: 'selfVideo',
          latencyMs: roundMs(nowMs() - runStartedAt),
          mime,
          timesliceMs,
          videoBitsPerSecond,
        });
        this.deps.log('Self video MediaRecorder started', {
          quality: this.selfVideoQuality,
          mime,
          videoBitsPerSecond,
        });
        resolve();
      };

      recorder.start(timesliceMs);
    });
  }

  private async openStorageTarget(filename: string, mimeType: string): Promise<StorageTarget> {
    if (!this.deps.openTarget) return new InMemoryStorageTarget(filename, mimeType);

    try {
      return await this.deps.openTarget(filename);
    } catch (e) {
      this.deps.warn(
        'Failed to open storage target, falling back to RAM buffer',
        describeMediaError(e)
      );
      return new InMemoryStorageTarget(filename, mimeType);
    }
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
      this.deps.warn('mic getUserMedia failed (continuing without mic):', describeMediaError(e));
      return null;
    }
  }

  private async maybeGetSelfVideoStream(): Promise<MediaStream | null> {
    if (!this.recordSelfVideo) return null;
    const profile = this.getSelfVideoProfile();

    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: profile.constraints,
          audio: false,
        }),
        TIMEOUTS.GUM_MS,
        'self video getUserMedia'
      );

      const t = stream.getVideoTracks()[0];
      const settings = t?.getSettings?.();
      this.deps.log('self video stream acquired:', {
        ok: !!t,
        quality: this.selfVideoQuality,
        width: settings?.width,
        height: settings?.height,
        frameRate: settings?.frameRate,
        deviceId: settings?.deviceId,
        muted: t?.muted,
        enabled: t?.enabled,
      });
      logPerf(this.deps.log, 'recorder', 'self_video_stream_acquired', {
        quality: this.selfVideoQuality,
        width: settings?.width,
        height: settings?.height,
        frameRate: settings?.frameRate,
      });
      return stream;
    } catch (e) {
      this.deps.warn(
        'self video getUserMedia failed (continuing without self video):',
        describeMediaError(e)
      );
      return null;
    }
  }

  private onRecorderStarted() {
    if (this.activeRecorders === 0) this.deps.notifyPhase('recording');
    this.activeRecorders += 1;
  }

  private onRecorderStopped() {
    this.activeRecorders = Math.max(0, this.activeRecorders - 1);

    if (this.activeRecorders === 0) {
      const artifacts = [...this.finalizedArtifacts];
      this.state = 'idle';
      this.safeStopStream(this.tabStream);
      this.safeStopStream(this.micStream);
      this.safeStopStream(this.selfVideoStream);
      this.tabStream = null;
      this.micStream = null;
      this.selfVideoStream = null;
      this.finalizedArtifacts = [];

      const resolveStop = this.resolveStop;
      this.resolveStop = null;
      this.stopPromise = null;
      resolveStop?.(artifacts);
    }
  }

  private safeStopStream(stream: MediaStream | null) {
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  private resetRunState() {
    this.activeRecorders = 0;
    this.tabRecorder = null;
    this.micRecorder = null;
    this.selfVideoRecorder = null;
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
    this.selfVideoQuality = 'standard';
    this.finalizedArtifacts = [];
    this.stopPromise = null;
    this.resolveStop = null;
  }

  private async inferSuffixFromActiveTab(): Promise<string> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url || null;

    try {
      if (!url) return 'google-meet';
      const u = new URL(url);
      return u.pathname.split('/').pop() || 'google-meet';
    } catch {
      return 'google-meet';
    }
  }

  private getChunkTimesliceMs(): number {
    if (PERF_FLAGS.extendedTimeslice && (this.deps.enableMicMix || this.recordSelfVideo)) {
      return EXTENDED_CHUNK_TIMESLICE_MS;
    }
    return CHUNK_TIMESLICE_MS;
  }

  private resolveSelfVideoBitrate(
    fallbackBitsPerSecond: number,
    settings?: MediaTrackSettings
  ): number {
    if (!PERF_FLAGS.adaptiveSelfVideoProfile) return fallbackBitsPerSecond;

    const width = settings?.width;
    const height = settings?.height;
    const frameRate = settings?.frameRate;
    if (!width || !height || !frameRate) return fallbackBitsPerSecond;

    const estimated = Math.round(
      width * height * frameRate * (this.selfVideoQuality === 'high' ? 0.1 : 0.075)
    );
    const minBitsPerSecond = this.selfVideoQuality === 'high' ? 1_000_000 : 500_000;
    return clamp(estimated, minBitsPerSecond, fallbackBitsPerSecond);
  }
}

class AudioPlaybackBridge {
  private readonly deps: RecorderEngineDeps;
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
      this.deps.warn('Audio playback bridge failed (non-fatal)', describeMediaError(e));
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
