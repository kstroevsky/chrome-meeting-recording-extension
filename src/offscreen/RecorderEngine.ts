/**
 * @file offscreen/RecorderEngine.ts
 *
 * Core recording logic. Captures tab audio+video and optional microphone/self
 * video streams, writes chunks to local storage targets, and returns sealed
 * local artifacts once capture stops.
 */

import { AudioPlaybackBridge, MixedAudioMixer } from './RecorderAudio';
import {
  captureTabStreamFromId,
  inferActiveTabSuffix,
  maybeGetMicStream,
  maybeGetSelfVideoStream,
} from './RecorderCapture';
import {
  getDefaultSelfVideoBitrate,
  getAudioMime,
  getChunkTimesliceMs,
  getVideoMime,
  getVideoOnlyMime,
  resolveSelfVideoBitrate,
} from './RecorderProfiles';
import { describeMediaError } from './RecorderSupport';
import { PERF_FLAGS, debugPerf, logPerf, nowMs, roundMs } from '../shared/perf';
import {
  DEFAULT_RECORDING_RUN_CONFIG,
  type MicMode,
  type RecordingPhase,
  type RecordingRunConfig,
  type RecordingStream,
} from '../shared/recording';
import { TIMEOUTS } from '../shared/timeouts';

type RecordingStateExtra = Record<string, any> | undefined;

type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';

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
  openTarget?: (filename: string) => Promise<StorageTarget>;
};

/** RAM-backed fallback target used when OPFS is unavailable for a stream. */
class InMemoryStorageTarget implements StorageTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;

  /** Stores filename and MIME so a final File can be assembled on close. */
  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
  ) {}

  /** Buffers a recorder chunk in memory until the stream is finalized. */
  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory target is closed');
    this.chunks.push(chunk);
  }

  /** Seals buffered chunks into a File-like artifact for downstream finalization. */
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

  private tabCaptureStream: MediaStream | null = null;
  private tabRecordingStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private selfVideoStream: MediaStream | null = null;

  private suffix = 'google-meet';
  private micMode: MicMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
  private recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;

  private playback: AudioPlaybackBridge | null = null;
  private mixedAudio: MixedAudioMixer | null = null;
  private stopPromise: Promise<CompletedRecordingArtifact[]> | null = null;
  private resolveStop: ((artifacts: CompletedRecordingArtifact[]) => void) | null = null;
  private finalizedArtifacts: CompletedRecordingArtifact[] = [];

  /** Creates a recorder engine bound to runtime logging, phase, and storage callbacks. */
  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  /** Returns true while a recording run is starting, active, or stopping. */
  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting' || this.state === 'stopping';
  }

  /** Exposes how many MediaRecorder instances are currently active for diagnostics. */
  getActiveRecorderCount(): number {
    return this.activeRecorders;
  }

  /** Returns the engine's internal state machine phase for diagnostics sampling. */
  getDebugState(): EngineState {
    return this.state;
  }

  /** Starts a full recording run from a background-provided tab capture stream id. */
  async startFromStreamId(streamId: string, options: RecordingRunConfig): Promise<void> {
    if (this.isRecording()) {
      this.deps.log('Already recording; ignoring start');
      return;
    }

    this.resetRunState();
    this.state = 'starting';
    this.runId += 1;
    const runId = this.runId;
    this.micMode = options.micMode;
    this.recordSelfVideo = options.recordSelfVideo;
    const runStartedAt = nowMs();

    try {
      const baseStream = await captureTabStreamFromId(streamId, this.deps);
      this.tabCaptureStream = baseStream;
      this.assertVideoTrack(baseStream);
      await this.ensureAudiblePlaybackIfSuppressed(baseStream);
      this.suffix = await inferActiveTabSuffix().catch(() => 'google-meet');
      this.attachTabEndedHandler(baseStream);

      let micForRun: MediaStream | null = null;
      if (this.micMode === 'mixed' || this.micMode === 'separate') {
        micForRun = await this.requireMicStream(runId);
        this.micStream = micForRun;
      }

      let tabRecorderStream = baseStream;
      if (this.micMode === 'mixed') {
        this.mixedAudio = new MixedAudioMixer(this.deps);
        tabRecorderStream = await this.mixedAudio.create(baseStream, micForRun!);
      }
      this.tabRecordingStream = tabRecorderStream;

      const tabStarted = this.startTabRecorder(tabRecorderStream, runStartedAt);
      if (this.micMode === 'separate') {
        void this.tryStartMicRecorder(runId, runStartedAt, micForRun).catch((e) =>
          this.deps.warn('Mic recorder start failed', describeMediaError(e))
        );
      }
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

  /** Stops every active recorder and resolves once all sealed artifacts are ready. */
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
    this.mixedAudio?.stop();
    this.mixedAudio = null;

    return this.stopPromise;
  }

  /** Revokes a locally created blob URL once download or upload work is complete. */
  revokeBlobUrl(blobUrl: string) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  /** Enforces the invariant that the captured tab stream must contain video. */
  private assertVideoTrack(stream: MediaStream) {
    if (!stream.getVideoTracks().length) throw new Error('No video track in captured stream');
  }

  /** Stops the run if Chrome ends the captured tab's video track unexpectedly. */
  private attachTabEndedHandler(stream: MediaStream) {
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Video track ended');
      if (this.tabRecorder && this.isRecording()) { try { this.tabRecorder.stop(); } catch {} }
      if (this.micRecorder && this.isRecording()) { try { this.micRecorder.stop(); } catch {} }
      if (this.selfVideoRecorder && this.isRecording()) { try { this.selfVideoRecorder.stop(); } catch {} }
    });
  }

  /** Acquires a microphone stream and rejects stale streams from an old run. */
  private async requireMicStream(runId: number): Promise<MediaStream> {
    const mic = await maybeGetMicStream(this.micMode, this.deps);
    if (!mic?.getAudioTracks().length) {
      throw new Error('Microphone stream is required for mixed microphone mode');
    }
    if (this.runId !== runId || this.state === 'stopping' || this.state === 'idle') {
      mic.getTracks().forEach((track) => track.stop());
      throw new Error('Microphone stream became stale before recording could start');
    }
    return mic;
  }

  /** Restores speaker playback when Chrome suppresses local tab audio during capture. */
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

  /** Starts the main tab recorder and streams chunks into the selected storage target. */
  private async startTabRecorder(recordingStream: MediaStream, runStartedAt: number): Promise<void> {
    const mime = getVideoMime();
    let started = false;
    const timesliceMs = getChunkTimesliceMs(this.micMode, this.recordSelfVideo);

    const recorder = new MediaRecorder(recordingStream, {
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
      this.safeStopStream(this.tabCaptureStream);
      this.safeStopStream(this.tabRecordingStream);
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

  /** Starts the separate microphone recorder when the run config requires it. */
  private async tryStartMicRecorder(
    runId: number,
    runStartedAt: number,
    existingMic?: MediaStream | null
  ): Promise<void> {
    const mic = existingMic ?? await maybeGetMicStream(this.micMode, this.deps);
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
    const mime = getAudioMime();
    let started = false;
    const timesliceMs = getChunkTimesliceMs(this.micMode, this.recordSelfVideo);
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

  /** Starts the separate self-video recorder when camera capture is enabled. */
  private async tryStartSelfVideoRecorder(runId: number, runStartedAt: number): Promise<void> {
    const selfVideo = await maybeGetSelfVideoStream(this.recordSelfVideo, this.deps);
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
    const defaultVideoBitsPerSecond = getDefaultSelfVideoBitrate();
    const mime = getVideoOnlyMime();
    let started = false;
    const timesliceMs = getChunkTimesliceMs(this.micMode, this.recordSelfVideo);
    const track = selfVideo.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    logPerf(this.deps.log, 'recorder', 'self_video_stream_acquired', {
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate,
    });
    const videoBitsPerSecond = resolveSelfVideoBitrate(defaultVideoBitsPerSecond, settings);
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
        this.deps.log('Self video MediaRecorder started', { mime, videoBitsPerSecond });
        resolve();
      };

      recorder.start(timesliceMs);
    });
  }

  /** Opens the preferred storage target and falls back to RAM buffering on failure. */
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

  /** Tracks recorder starts and emits `recording` once the first recorder is live. */
  private onRecorderStarted() {
    if (this.activeRecorders === 0) this.deps.notifyPhase('recording');
    this.activeRecorders += 1;
  }

  /** Finalizes run state once the last active recorder has stopped. */
  private onRecorderStopped() {
    this.activeRecorders = Math.max(0, this.activeRecorders - 1);

    if (this.activeRecorders === 0) {
      const artifacts = [...this.finalizedArtifacts];
      this.state = 'idle';
      this.safeStopStream(this.tabCaptureStream);
      this.safeStopStream(this.tabRecordingStream);
      this.safeStopStream(this.micStream);
      this.safeStopStream(this.selfVideoStream);
      this.tabCaptureStream = null;
      this.tabRecordingStream = null;
      this.micStream = null;
      this.selfVideoStream = null;
      this.playback?.stop();
      this.playback = null;
      this.mixedAudio?.stop();
      this.mixedAudio = null;
      this.finalizedArtifacts = [];

      const resolveStop = this.resolveStop;
      this.resolveStop = null;
      this.stopPromise = null;
      resolveStop?.(artifacts);
    }
  }

  /** Best-effort helper that stops every track in a stream without surfacing cleanup errors. */
  private safeStopStream(stream: MediaStream | null) {
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  /** Clears all per-run state before a new start or after a failed setup. */
  private resetRunState() {
    this.activeRecorders = 0;
    this.tabRecorder = null;
    this.micRecorder = null;
    this.selfVideoRecorder = null;
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.safeStopStream(this.selfVideoStream);
    this.tabCaptureStream = null;
    this.tabRecordingStream = null;
    this.micStream = null;
    this.selfVideoStream = null;
    this.playback?.stop();
    this.playback = null;
    this.mixedAudio?.stop();
    this.mixedAudio = null;
    this.suffix = 'google-meet';
    this.micMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
    this.recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
    this.finalizedArtifacts = [];
    this.stopPromise = null;
    this.resolveStop = null;
  }
}
