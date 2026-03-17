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
  type RecorderVideoContainer,
  getDefaultSelfVideoBitrate,
  getAudioMime,
  getChunkTimesliceMs,
  getNativeSelfVideoMp4Mime,
  getNativeTabMp4Mime,
  getSelfVideoProfile,
  getVideoMime,
  getVideoOnlyMime,
  resolveSelfVideoBitrate,
} from './RecorderProfiles';
import { describeMediaError } from './RecorderSupport';
import { readStreamVideoMetrics } from './RecorderVideoResizer';
import {
  buildRecorderRuntimeSettingsSnapshot,
  type RecorderRuntimeSettingsSnapshot,
} from '../shared/extensionSettings';
import { PERF_FLAGS, debugPerf, logPerf, nowMs, roundMs } from '../shared/perf';
import { EXTENSION_DEFAULTS } from '../shared/recordingConstants';
import {
  DEFAULT_RECORDING_RUN_CONFIG,
  type MicMode,
  type RecordingPhase,
  type RecordingRunConfig,
  type RecordingStream,
} from '../shared/recording';
import { TIMEOUTS } from '../shared/timeouts';
import type { VideoResizeTarget } from './RecorderVideoResizer';

type RecordingStateExtra = Record<string, any> | undefined;

type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';

type PreparedTabRecorderStream = {
  stream: MediaStream;
  finalize: RecordingArtifactFinalizePlan;
  attemptLiveMp4Delivery: boolean;
};

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

export type RecordingArtifactFinalizePlan = {
  outputContainer: RecorderVideoContainer;
  resizeTabOutput: boolean;
  outputTarget?: VideoResizeTarget;
};

export type RecordingArtifactRole = 'master' | 'delivery';

export type CompletedRecordingArtifact = {
  stream: RecordingStream;
  artifact: SealedStorageFile;
  container: RecorderVideoContainer;
  role: RecordingArtifactRole;
  finalize?: RecordingArtifactFinalizePlan;
};

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
  notifyPhase: (phase: RecordingPhase, extra?: RecordingStateExtra) => void;
  reportWarning?: (warning: string) => void;
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
  private tabDeliveryRecorder: MediaRecorder | null = null;
  private micRecorder: MediaRecorder | null = null;
  private selfVideoRecorder: MediaRecorder | null = null;
  private selfVideoDeliveryRecorder: MediaRecorder | null = null;

  private tabCaptureStream: MediaStream | null = null;
  private tabRecordingStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private selfVideoStream: MediaStream | null = null;
  private tabFinalizePlan: RecordingArtifactFinalizePlan | null = null;
  private selfVideoFinalizePlan: RecordingArtifactFinalizePlan | null = null;
  private recorderSettings: RecorderRuntimeSettingsSnapshot | null = null;

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
  async startFromStreamId(
    streamId: string,
    options: RecordingRunConfig,
    recorderSettings: RecorderRuntimeSettingsSnapshot = buildRecorderRuntimeSettingsSnapshot()
  ): Promise<void> {
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
    this.recorderSettings = recorderSettings;
    const runStartedAt = nowMs();

    try {
      this.deps.log('Recorder settings snapshot for run', recorderSettings);

      const baseStream = await captureTabStreamFromId(streamId, recorderSettings.tab.output, this.deps);
      this.tabCaptureStream = baseStream;
      this.assertVideoTrack(baseStream);
      this.deps.log('tab source stream acquired:', readStreamVideoMetrics(baseStream));
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
      const preparedTabRecorder = await this.prepareTabRecorderStream(tabRecorderStream);
      tabRecorderStream = preparedTabRecorder.stream;
      this.tabFinalizePlan = preparedTabRecorder.finalize;
      this.tabRecordingStream = tabRecorderStream;

      const tabStarted = this.startTabRecorder(tabRecorderStream, runStartedAt);
      if (preparedTabRecorder.attemptLiveMp4Delivery) {
        void this.tryStartTabMp4Recorder(tabRecorderStream, runStartedAt).catch((e) =>
          this.deps.warn('Tab MP4 recorder start failed (continuing with WebM master only)', describeMediaError(e))
        );
      }
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
    try { this.tabDeliveryRecorder?.stop(); } catch (e) { this.deps.error('Tab MP4 stop error', describeMediaError(e)); }
    try { this.micRecorder?.stop(); } catch (e) { this.deps.error('Mic stop error', describeMediaError(e)); }
    try { this.selfVideoRecorder?.stop(); } catch (e) { this.deps.error('Self video stop error', describeMediaError(e)); }
    try { this.selfVideoDeliveryRecorder?.stop(); } catch (e) { this.deps.error('Self video MP4 stop error', describeMediaError(e)); }
    this.releaseSelfVideoCapture();

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
      if (this.tabDeliveryRecorder && this.isRecording()) { try { this.tabDeliveryRecorder.stop(); } catch {} }
      if (this.micRecorder && this.isRecording()) { try { this.micRecorder.stop(); } catch {} }
      if (this.selfVideoRecorder && this.isRecording()) { try { this.selfVideoRecorder.stop(); } catch {} }
      if (this.selfVideoDeliveryRecorder && this.isRecording()) { try { this.selfVideoDeliveryRecorder.stop(); } catch {} }
    });
  }

  /** Emits a warning both to logs and to the popup-visible session warning list. */
  private reportWarning(message: string): void {
    const warning = message.trim();
    if (!warning) return;
    this.deps.warn(warning);
    this.deps.reportWarning?.(warning);
  }

  /** Formats width/height/frameRate tuples in a compact, user-visible form. */
  private formatVideoMetrics(
    width?: number,
    height?: number,
    frameRate?: number
  ): string {
    const resolution =
      typeof width === 'number' && typeof height === 'number'
        ? `${width}x${height}`
        : 'unknown resolution';
    const fps = typeof frameRate === 'number' ? `@${Math.round(frameRate * 10) / 10}fps` : '';
    return `${resolution}${fps}`;
  }

  /** Returns the requested final tab-output target derived from extension settings. */
  private getTabOutputTarget(): VideoResizeTarget {
    const tabOutput = this.getRequiredRecorderSettings().tab.output;
    return {
      width: tabOutput.maxWidth,
      height: tabOutput.maxHeight,
      frameRate: Math.min(
        tabOutput.maxFrameRate,
        EXTENSION_DEFAULTS.capture.tab.maxFrameRate
      ),
    };
  }

  /** Reports when the browser delivers a different camera profile than requested. */
  private maybeReportSelfVideoWarning(settings?: MediaTrackSettings): void {
    const profile = getSelfVideoProfile(this.getRequiredRecorderSettings().selfVideo.profile);
    const deliveredWidth = settings?.width;
    const deliveredHeight = settings?.height;
    const deliveredFrameRate = settings?.frameRate;
    const sizeMismatch =
      deliveredWidth !== profile.width
      || deliveredHeight !== profile.height;
    const frameRateMismatch =
      typeof deliveredFrameRate === 'number'
      && deliveredFrameRate + 0.5 < profile.frameRate;

    if (!sizeMismatch && !frameRateMismatch) return;

    this.reportWarning(
      `Camera recording requested ${this.formatVideoMetrics(profile.width, profile.height, profile.frameRate)}, `
      + `but browser delivered ${this.formatVideoMetrics(deliveredWidth, deliveredHeight, deliveredFrameRate)}. `
      + 'Extension camera quality is controlled by extension settings; shared camera use or hardware limits can reduce the delivered profile.'
    );
  }

  /** Stops and releases the extension-owned self-video stream without touching recorder state. */
  private releaseSelfVideoCapture(): void {
    this.safeStopStream(this.selfVideoStream);
    this.selfVideoStream = null;
  }

  /** Prepares the live tab master recording and records post-stop delivery requirements. */
  private async prepareTabRecorderStream(sourceStream: MediaStream): Promise<PreparedTabRecorderStream> {
    const output = this.getRequiredRecorderSettings().tab;
    const sourceMetrics = readStreamVideoMetrics(sourceStream);
    const target = output.resizePostprocess ? this.getTabOutputTarget() : undefined;
    const requestedOutputContainer: RecorderVideoContainer = output.mp4Output ? 'mp4' : 'webm';
    const tabMp4Supported = output.mp4Output ? !!getNativeTabMp4Mime() : false;
    const keepOriginalWebm = output.mp4Output && !tabMp4Supported;

    if (keepOriginalWebm) {
      this.reportWarning(
        output.resizePostprocess
          ? 'Tab MP4 delivery with audio is not supported in this Chrome runtime. The original WebM tab recording will be kept unchanged, so resize-after-capture is skipped for this recording.'
          : 'Tab MP4 delivery with audio is not supported in this Chrome runtime. The original WebM tab recording will be kept unchanged.'
      );
    }

    const resolvedOutputContainer: RecorderVideoContainer = keepOriginalWebm ? 'webm' : requestedOutputContainer;
    const resolvedResizePostprocess = keepOriginalWebm ? false : output.resizePostprocess;
    const resolvedTarget = resolvedResizePostprocess ? target : undefined;

    this.deps.log('tab recorder input stream:', {
      resized: false,
      sourceWidth: sourceMetrics.width,
      sourceHeight: sourceMetrics.height,
      sourceFrameRate: sourceMetrics.frameRate,
      width: sourceMetrics.width,
      height: sourceMetrics.height,
      frameRate: sourceMetrics.frameRate,
      targetWidth: target?.width,
      targetHeight: target?.height,
      targetFrameRate: target?.frameRate,
      requestedOutputContainer,
      requestedResizePostprocess: output.resizePostprocess,
      resolvedOutputContainer,
      resolvedResizePostprocess,
      resolvedTargetWidth: resolvedTarget?.width,
      resolvedTargetHeight: resolvedTarget?.height,
      resolvedTargetFrameRate: resolvedTarget?.frameRate,
      tabMp4Output: output.mp4Output,
      tabMp4Supported,
    });

    return {
      stream: sourceStream,
      finalize: {
        outputContainer: resolvedOutputContainer,
        resizeTabOutput: resolvedResizePostprocess,
        outputTarget: resolvedTarget,
      },
      attemptLiveMp4Delivery: resolvedOutputContainer === 'mp4' && !resolvedResizePostprocess,
    };
  }

  /** Acquires a microphone stream and rejects stale streams from an old run. */
  private async requireMicStream(runId: number): Promise<MediaStream> {
    const mic = await maybeGetMicStream(
      this.micMode,
      this.getRequiredRecorderSettings().microphone,
      this.deps
    );
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
    const timesliceMs = getChunkTimesliceMs('tab', this.getRequiredRecorderSettings().chunking);

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
        if (artifact) {
          this.finalizedArtifacts.push({
            stream: 'tab',
            artifact,
            container: 'webm',
            role: 'master',
            finalize: this.tabFinalizePlan ? { ...this.tabFinalizePlan } : undefined,
          });
        }
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
      if (this.tabDeliveryRecorder && this.tabDeliveryRecorder.state !== 'inactive') {
        try { this.tabDeliveryRecorder.stop(); } catch {}
      }
      if (this.micRecorder && this.micRecorder.state !== 'inactive') {
        try { this.micRecorder.stop(); } catch {}
      }
      if (this.selfVideoRecorder && this.selfVideoRecorder.state !== 'inactive') {
        try { this.selfVideoRecorder.stop(); } catch {}
      }
      if (this.selfVideoDeliveryRecorder && this.selfVideoDeliveryRecorder.state !== 'inactive') {
        try { this.selfVideoDeliveryRecorder.stop(); } catch {}
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

  /** Starts an optional live native MP4 recorder for the tab stream without affecting the WebM master path. */
  private async tryStartTabMp4Recorder(recordingStream: MediaStream, runStartedAt: number): Promise<void> {
    const mime = getNativeTabMp4Mime();
    if (!mime) {
      this.reportWarning('Tab MP4 delivery is not supported in this Chrome runtime. The original WebM tab recording will be kept.');
      return;
    }

    const recorder = new MediaRecorder(recordingStream, {
      mimeType: mime,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });
    this.tabDeliveryRecorder = recorder;

    const filename = `google-meet-recording-${this.suffix}-${Date.now()}.mp4`;
    const target = await this.openStorageTarget(filename, mime);
    const timesliceMs = getChunkTimesliceMs('tab', this.getRequiredRecorderSettings().chunking);
    let started = false;
    let failed = false;

    const finalize = async () => {
      try {
        const artifact = await target.close();
        if (artifact) {
          if (!failed) {
            this.finalizedArtifacts.push({
              stream: 'tab',
              artifact,
              container: 'mp4',
              role: 'delivery',
            });
          } else {
            await artifact.cleanup().catch(() => {});
          }
        }
      } catch (error) {
        this.deps.warn('Tab MP4 finalize failed; WebM master will be used instead', describeMediaError(error));
      } finally {
        this.tabDeliveryRecorder = null;
        if (started) this.onRecorderStopped();
      }
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data?.size) return;
      void target.write(event.data).catch((error) => {
        failed = true;
        this.deps.warn('Tab MP4 write failed; falling back to WebM master', describeMediaError(error));
        try { recorder.stop(); } catch {}
      });
    };

    recorder.onerror = (event: any) => {
      failed = true;
      this.deps.warn('Tab MP4 recorder failed; falling back to WebM master', describeMediaError(event));
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch {}
      }
    };

    recorder.onstop = () => {
      void finalize();
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Tab MP4 MediaRecorder did not start (timeout)')),
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
          role: 'delivery',
        });
        this.deps.log('Tab MP4 MediaRecorder started', { mime });
        resolve();
      };

      recorder.start(timesliceMs);
    }).catch(async (error) => {
      this.tabDeliveryRecorder = null;
      const artifact = await target.close().catch(() => null);
      await artifact?.cleanup().catch(() => {});
      throw error;
    });
  }

  /** Starts the separate microphone recorder when the run config requires it. */
  private async tryStartMicRecorder(
    runId: number,
    runStartedAt: number,
    existingMic?: MediaStream | null
  ): Promise<void> {
    const mic = existingMic ?? await maybeGetMicStream(
      this.micMode,
      this.getRequiredRecorderSettings().microphone,
      this.deps
    );
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
    const timesliceMs = getChunkTimesliceMs('mic', this.getRequiredRecorderSettings().chunking);
    const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 96_000 });
    this.micRecorder = recorder;

    const filename = `google-meet-mic-${this.suffix}-${Date.now()}.webm`;
    const target = await this.openStorageTarget(filename, mime);

    const finalize = async (label: string) => {
      try {
        const artifact = await target.close();
        if (artifact) {
          this.finalizedArtifacts.push({
            stream: 'mic',
            artifact,
            container: 'webm',
            role: 'master',
          });
        }
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
    const settings = this.getRequiredRecorderSettings();
    const selfVideo = await maybeGetSelfVideoStream(this.recordSelfVideo, settings.selfVideo.profile, this.deps);
    if (
      !selfVideo?.getVideoTracks().length ||
      this.runId !== runId ||
      this.state === 'stopping' ||
      this.state === 'idle'
    ) {
      selfVideo?.getTracks().forEach((t) => t.stop());
      this.releaseSelfVideoCapture();
      if (selfVideo?.getVideoTracks().length) {
        this.deps.log('Self video stream obtained after stop; discarding it');
      } else {
        this.deps.warn('Self video stream unavailable; continuing without camera recording');
      }
      return;
    }

    this.selfVideoStream = selfVideo;
    this.selfVideoFinalizePlan = {
      outputContainer: settings.selfVideo.mp4Output ? 'mp4' : 'webm',
      resizeTabOutput: false,
    };
    const defaultVideoBitsPerSecond = getDefaultSelfVideoBitrate(settings.selfVideo.profile);
    const mime = getVideoOnlyMime();
    let started = false;
    const timesliceMs = getChunkTimesliceMs('selfVideo', settings.chunking);
    const track = selfVideo.getVideoTracks()[0];
    const trackSettings = track?.getSettings?.();
    logPerf(this.deps.log, 'recorder', 'self_video_stream_acquired', {
      width: trackSettings?.width,
      height: trackSettings?.height,
      frameRate: trackSettings?.frameRate,
    });
    this.maybeReportSelfVideoWarning(trackSettings);
    const videoBitsPerSecond = resolveSelfVideoBitrate(
      defaultVideoBitsPerSecond,
      trackSettings,
      settings.selfVideo.profile.minAdaptiveBitsPerSecond
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
        if (artifact) {
          this.finalizedArtifacts.push({
            stream: 'selfVideo',
            artifact,
            container: 'webm',
            role: 'master',
            finalize: this.selfVideoFinalizePlan ? { ...this.selfVideoFinalizePlan } : undefined,
          });
        }
      } catch (e) {
        this.deps.error(`${label} finalize/save failed`, describeMediaError(e));
      } finally {
        this.selfVideoRecorder = null;
        this.releaseSelfVideoCapture();
        if (started) this.onRecorderStopped();
      }
    };

    selfVideo.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.deps.log('Self video track ended');
      if (this.selfVideoRecorder && this.selfVideoRecorder.state !== 'inactive') {
        try { this.selfVideoRecorder.stop(); } catch {}
      }
      if (this.selfVideoDeliveryRecorder && this.selfVideoDeliveryRecorder.state !== 'inactive') {
        try { this.selfVideoDeliveryRecorder.stop(); } catch {}
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
      if (this.selfVideoDeliveryRecorder && this.selfVideoDeliveryRecorder.state !== 'inactive') {
        try { this.selfVideoDeliveryRecorder.stop(); } catch {}
      }
      this.releaseSelfVideoCapture();
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

    if (settings.selfVideo.mp4Output) {
      void this.tryStartSelfVideoMp4Recorder(selfVideo, runStartedAt).catch((e) =>
        this.deps.warn('Self video MP4 recorder start failed (continuing with WebM master only)', describeMediaError(e))
      );
    }
  }

  /** Starts an optional live native MP4 recorder for the self-video stream. */
  private async tryStartSelfVideoMp4Recorder(selfVideo: MediaStream, runStartedAt: number): Promise<void> {
    const mime = getNativeSelfVideoMp4Mime();
    if (!mime) {
      this.reportWarning('Camera MP4 delivery is not supported in this Chrome runtime. The original WebM camera recording will be kept.');
      return;
    }

    const recorderSettings = this.getRequiredRecorderSettings();
    const defaultVideoBitsPerSecond = getDefaultSelfVideoBitrate(recorderSettings.selfVideo.profile);
    const track = selfVideo.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const videoBitsPerSecond = resolveSelfVideoBitrate(
      defaultVideoBitsPerSecond,
      settings,
      recorderSettings.selfVideo.profile.minAdaptiveBitsPerSecond
    );
    const recorder = new MediaRecorder(selfVideo, {
      mimeType: mime,
      videoBitsPerSecond,
    });
    this.selfVideoDeliveryRecorder = recorder;

    const filename = `google-meet-self-video-${this.suffix}-${Date.now()}.mp4`;
    const target = await this.openStorageTarget(filename, mime);
    const timesliceMs = getChunkTimesliceMs('selfVideo', recorderSettings.chunking);
    let started = false;
    let failed = false;

    const finalize = async () => {
      try {
        const artifact = await target.close();
        if (artifact) {
          if (!failed) {
            this.finalizedArtifacts.push({
              stream: 'selfVideo',
              artifact,
              container: 'mp4',
              role: 'delivery',
            });
          } else {
            await artifact.cleanup().catch(() => {});
          }
        }
      } catch (error) {
        this.deps.warn('Self video MP4 finalize failed; WebM master will be used instead', describeMediaError(error));
      } finally {
        this.selfVideoDeliveryRecorder = null;
        if (started) this.onRecorderStopped();
      }
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data?.size) return;
      void target.write(event.data).catch((error) => {
        failed = true;
        this.deps.warn('Self video MP4 write failed; falling back to WebM master', describeMediaError(error));
        try { recorder.stop(); } catch {}
      });
    };

    recorder.onerror = (event: any) => {
      failed = true;
      this.deps.warn('Self video MP4 recorder failed; falling back to WebM master', describeMediaError(event));
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch {}
      }
    };

    recorder.onstop = () => {
      void finalize();
    };

    await new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Self video MP4 MediaRecorder did not start (timeout)')),
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
          role: 'delivery',
          videoBitsPerSecond,
        });
        this.deps.log('Self video MP4 MediaRecorder started', { mime, videoBitsPerSecond });
        resolve();
      };

      recorder.start(timesliceMs);
    }).catch(async (error) => {
      this.selfVideoDeliveryRecorder = null;
      const artifact = await target.close().catch(() => null);
      await artifact?.cleanup().catch(() => {});
      throw error;
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
      this.releaseSelfVideoCapture();
      this.tabCaptureStream = null;
      this.tabRecordingStream = null;
      this.micStream = null;
      this.playback?.stop();
      this.playback = null;
      this.mixedAudio?.stop();
      this.mixedAudio = null;
      this.finalizedArtifacts = [];
      this.tabFinalizePlan = null;
      this.selfVideoFinalizePlan = null;
      this.recorderSettings = null;

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

  /** Returns the frozen per-run recorder settings, failing loudly if start wiring broke. */
  private getRequiredRecorderSettings(): RecorderRuntimeSettingsSnapshot {
    if (!this.recorderSettings) {
      throw new Error('Recorder settings snapshot is missing for the active run');
    }
    return this.recorderSettings;
  }

  /** Clears all per-run state before a new start or after a failed setup. */
  private resetRunState() {
    this.activeRecorders = 0;
    this.tabRecorder = null;
    this.tabDeliveryRecorder = null;
    this.micRecorder = null;
    this.selfVideoRecorder = null;
    this.selfVideoDeliveryRecorder = null;
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.releaseSelfVideoCapture();
    this.tabCaptureStream = null;
    this.tabRecordingStream = null;
    this.micStream = null;
    this.playback?.stop();
    this.playback = null;
    this.mixedAudio?.stop();
    this.mixedAudio = null;
    this.micMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
    this.recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
    this.recorderSettings = null;
    this.finalizedArtifacts = [];
    this.tabFinalizePlan = null;
    this.selfVideoFinalizePlan = null;
    this.stopPromise = null;
    this.resolveStop = null;
  }
}
