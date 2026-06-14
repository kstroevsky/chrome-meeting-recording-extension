/**
 * @file offscreen/RecorderEngine.ts
 *
 * State machine facade that coordinates tab, mic, and self-video recorder tasks.
 * Stream acquisition and audio mixing are delegated to RecorderEngineSetup;
 * per-stream recording tasks live in ./engine/Tab|Mic|SelfVideoRecorderTask.
 */

import { captureTabStreamFromId } from './RecorderCapture';
import { buildRecorderRuntimeSettingsSnapshot, type RecorderRuntimeSettingsSnapshot } from '../shared/settings';
import { DEFAULT_RECORDING_RUN_CONFIG, isStoppablePhase, type MicMode, type RecordingRunConfig, type RecordingStream } from '../shared/recording';
import { describeMediaError } from './RecorderSupport';
import type { MixedAudioMixer } from './RecorderAudio';
import type { AudioPlaybackBridge } from './RecorderAudio';

import { startTabRecorder } from './engine/TabRecorderTask';
import { startMicRecorder } from './engine/MicRecorderTask';
import { startSelfVideoRecorder } from './engine/SelfVideoRecorderTask';
import {
  acquireMicStream,
  attachTabEndedHandler,
  createMixedTabStream,
  ensureAudiblePlayback,
  logStreamAcquired,
} from './engine/RecorderEngineSetup';
import type {
  CompletedRecordingArtifact,
  EngineState,
  RecorderEngineDeps,
  RecorderTrack,
} from './engine/RecorderEngineTypes';
import { debugPerf, nowMs, roundMs } from '../shared/perf';

// Re-export types for consumers that import from the engine root.
export type {
  SealedStorageFile,
  StorageTarget,
  CompletedRecordingArtifact,
  RecorderEngineDeps,
} from './engine/RecorderEngineTypes';

export class RecorderEngine {
  private readonly deps: RecorderEngineDeps;

  private state: EngineState = 'idle';
  private activeRecorders = 0;
  private runId = 0;

  private tracks: RecorderTrack[] = [];

  private tabCaptureStream: MediaStream | null = null;
  private tabRecordingStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;

  private suffix = '';
  private micMode: MicMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
  private recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
  private micMuted = false;
  private cameraMuted = false;
  private selfVideoSetMuted: ((muted: boolean) => void) | null = null;

  private playback: AudioPlaybackBridge | null = null;
  private mixedAudio: MixedAudioMixer | null = null;
  private stopPromise: Promise<CompletedRecordingArtifact[]> | null = null;
  private resolveStop: ((artifacts: CompletedRecordingArtifact[]) => void) | null = null;
  private finalizedArtifacts: CompletedRecordingArtifact[] = [];
  private pendingStartPromises: Promise<void>[] = [];

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
    // Bind the per-stream stop onto our (live) deps so sub-components — e.g. a
    // RAM-buffer target that overflowed — can stop just their own optional stream
    // without a reference to the engine. Set the property in place rather than
    // copying, so deps the caller assigns later (e.g. openTarget) stay visible.
    this.deps.requestStopStream = (stream) => this.stopStream(stream);
  }

  isRecording(): boolean {
    return isStoppablePhase(this.state);
  }

  getActiveRecorderCount(): number { return this.activeRecorders; }
  getDebugState(): EngineState { return this.state; }

  /**
   * Mutes or unmutes the live microphone. Silence-in-place: `track.enabled =
   * false` keeps the track live — so the MediaRecorder timeline stays
   * continuous, with no gap or re-acquisition glitch — while it emits zeroed
   * samples. Covers both mic modes: the disabled track feeds silence into the
   * mixed-audio graph (mixed) or the mic-only recorder (separate). The desired
   * state is remembered so it also applies to a mic stream still being acquired
   * when this is called (a mute toggled during the `starting` phase).
   */
  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.applyMicMuteState();
  }

  private applyMicMuteState(): void {
    for (const track of this.micStream?.getAudioTracks() ?? []) {
      try { track.enabled = !this.micMuted; } catch {}
    }
  }

  /**
   * Hides or shows the live camera on a self-video recording. Black-frames-in-place:
   * the camera track stays live (continuous timeline) but emits black frames. The
   * actuation lives in SelfVideoRecorderTask (it owns the camera + resize streams);
   * the engine just relays it. Remembered so it also applies to a camera still being
   * acquired when toggled during the `starting` phase.
   */
  setCameraMuted(muted: boolean): void {
    this.cameraMuted = muted;
    this.selfVideoSetMuted?.(muted);
  }

  async startFromStreamId(
    streamId: string,
    options: RecordingRunConfig,
    recorderSettings: RecorderRuntimeSettingsSnapshot = buildRecorderRuntimeSettingsSnapshot(),
    meetingSlug = ''
  ): Promise<void> {
    if (this.isRecording()) { this.deps.log('Already recording; ignoring start'); return; }

    this.resetRunState();
    this.state = 'starting';
    this.runId += 1;
    const runId = this.runId;
    this.micMode = options.micMode;
    this.recordSelfVideo = options.recordSelfVideo;
    this.suffix = meetingSlug;
    const runStartedAt = nowMs();
    debugPerf(this.deps.log, 'lifecycle', 'start_requested', {
      activeTracks: this.tracks.length,
      micMode: options.micMode,
      recordSelfVideo: options.recordSelfVideo,
      storageMode: options.storageMode,
    });

    try {
      const tabRecorderStream = await this.acquireRecordingStreams(streamId, options, recorderSettings, runId);
      const startTasks = this.buildRecorderStartTasks(tabRecorderStream, runId, runStartedAt, recorderSettings);
      this.pendingStartPromises = startTasks;
      await Promise.all(startTasks);
      this.pendingStartPromises = [];
      if (this.runId === runId && this.state === 'starting') this.state = 'recording';
      debugPerf(this.deps.log, 'lifecycle', 'start_completed', {
        durationMs: roundMs(nowMs() - runStartedAt),
        activeTracks: this.tracks.length,
      });
    } catch (e) {
      debugPerf(this.deps.log, 'lifecycle', 'failure', {
        stage: 'start',
        durationMs: roundMs(nowMs() - runStartedAt),
      });
      this.state = 'idle';
      this.resetRunState();
      throw e;
    }
  }

  /**
   * Acquires the tab capture stream, optional mic stream, and audio mixer.
   * Assigns results directly to instance fields so that `resetRunState()` can
   * clean up any partially-acquired resources if a later step throws.
   * Returns the stream the tab recorder should record from.
   */
  private async acquireRecordingStreams(
    streamId: string,
    options: RecordingRunConfig,
    recorderSettings: RecorderRuntimeSettingsSnapshot,
    runId: number
  ): Promise<MediaStream> {
    const baseStream = await captureTabStreamFromId(streamId, recorderSettings.tab.output, this.deps);
    this.tabCaptureStream = baseStream;
    logStreamAcquired(baseStream, this.deps);

    this.playback = await ensureAudiblePlayback(baseStream, this.deps);
    attachTabEndedHandler(baseStream, () => this.stopAllRecorders(), this.deps.log);

    if (options.micMode === 'mixed' || options.micMode === 'separate') {
      this.micStream = await acquireMicStream(runId, () => this.runId, () => this.state, options.micMode, recorderSettings, this.deps);
      this.applyMicMuteState();
    }

    if (options.micMode === 'mixed') {
      const { mixer, stream } = await createMixedTabStream(baseStream, this.micStream!, this.deps);
      this.mixedAudio = mixer;
      this.tabRecordingStream = stream;
      return stream;
    }

    this.tabRecordingStream = baseStream;
    return baseStream;
  }

  /** Builds the parallel recorder startup promises for tab, mic, and self-video. */
  private buildRecorderStartTasks(
    tabRecorderStream: MediaStream,
    runId: number,
    runStartedAt: number,
    recorderSettings: RecorderRuntimeSettingsSnapshot
  ): Promise<void>[] {
    const isStale = () => this.state === 'stopping' || this.state === 'idle';
    const tasks: Promise<void>[] = [
      startTabRecorder(tabRecorderStream, this.suffix, runStartedAt, recorderSettings, this.deps, {
        onStarted: () => this.onRecorderStarted(),
        onStopped: (artifact) => this.onTrackStopped('tab', artifact),
        onError: () => this.stopAllRecorders(),
      }).then((recorder) => this.registerTrack({ stream: 'tab', recorder })),
    ];

    if (this.micMode === 'separate') {
      tasks.push(
        startMicRecorder(runId, () => this.runId, isStale, this.suffix, runStartedAt, this.micMode, recorderSettings, this.micStream, this.deps, {
          onStarted: () => this.onRecorderStarted(),
          onStopped: (artifact) => { this.micStream = null; this.onTrackStopped('mic', artifact); },
        }).then((recorder) => { if (recorder) this.registerTrack({ stream: 'mic', recorder }); })
          .catch((e) => this.deps.warn('Mic recorder start failed', describeMediaError(e)))
      );
    }

    if (this.recordSelfVideo) {
      let stopStream: (() => void) | undefined;
      tasks.push(
        startSelfVideoRecorder(runId, () => this.runId, isStale, this.suffix, runStartedAt, this.recordSelfVideo, recorderSettings, this.deps, {
          onStarted: () => this.onRecorderStarted(),
          onStopped: (artifact) => { this.selfVideoSetMuted = null; this.onTrackStopped('self-video', artifact); },
          onWarning: (msg) => this.deps.reportWarning?.(msg),
          onStreamAcquired: (controls) => {
            stopStream = controls.stop;
            this.selfVideoSetMuted = controls.setMuted;
            controls.setMuted(this.cameraMuted);
          },
        }).then((recorder) => { if (recorder) this.registerTrack({ stream: 'self-video', recorder, stopStream }); })
          .catch((e) => this.deps.warn('Self video recorder start failed', describeMediaError(e)))
      );
    }

    return tasks;
  }

  async stop(): Promise<CompletedRecordingArtifact[]> {
    if (!this.tracks.some((t) => t.stream === 'tab') || !this.isRecording()) {
      this.deps.warn('Stop called but not recording');
      return Promise.resolve([]);
    }
    if (this.stopPromise) return this.stopPromise;

    const stopStartedAt = nowMs();
    debugPerf(this.deps.log, 'lifecycle', 'stop_requested', {
      activeTracks: this.tracks.length,
    });
    this.state = 'stopping';
    this.stopPromise = new Promise<CompletedRecordingArtifact[]>((resolve) => {
      this.resolveStop = resolve;
    });

    if (this.pendingStartPromises.length) {
      await Promise.allSettled(this.pendingStartPromises);
      this.pendingStartPromises = [];
    }

    this.stopAllRecorders();
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    const artifacts = await this.stopPromise;
    debugPerf(this.deps.log, 'lifecycle', 'stop_completed', {
      durationMs: roundMs(nowMs() - stopStartedAt),
      activeTracks: this.tracks.length,
      artifactCount: artifacts.length,
    });
    return artifacts;
  }

  revokeBlobUrl(blobUrl: string) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  private stopAllRecorders() {
    for (const track of [...this.tracks]) {
      track.stopStream?.();
      try { track.recorder.stop(); } catch (e) { this.deps.error(`${track.stream} stop error`, describeMediaError(e)); }
    }
  }

  /**
   * Stops a single *optional* stream without ending the session. The stopped
   * recorder's `onstop` seals its partial artifact and `onTrackStopped` removes
   * the track and decrements `activeRecorders` — which stays above zero while the
   * required tab stream runs, so the session keeps recording and the partial
   * artifact is delivered at the eventual session stop. Used by the RAM-buffer
   * backstop. The tab stream is never stopped this way (its storage failure is
   * handled by failing the start, and the RAM cap never applies to it).
   */
  private stopStream(stream: RecordingStream) {
    if (stream === 'tab') return;
    const track = this.tracks.find((t) => t.stream === stream);
    if (!track) return;
    this.deps.warn(`Stopping ${stream} stream early to bound its in-memory buffer`);
    track.stopStream?.();
    // Separate mic owns no `stopStream`; release its source here so the mic device
    // is freed when the recorder stops mid-session (mixed mic has no own target).
    if (stream === 'mic') this.safeStopStream(this.micStream);
    try { track.recorder.stop(); } catch (e) { this.deps.error(`${stream} stop error`, describeMediaError(e)); }
  }

  /** Adds a started recorder to the active track set. */
  private registerTrack(track: RecorderTrack): void {
    this.tracks.push(track);
  }

  /** Collects a stopped track's artifact, drops it from the set, then advances stop accounting. */
  private onTrackStopped(stream: RecordingStream, artifact: CompletedRecordingArtifact | null): void {
    if (artifact) this.finalizedArtifacts.push(artifact);
    this.tracks = this.tracks.filter((track) => track.stream !== stream);
    this.onRecorderStopped();
  }

  private onRecorderStarted() {
    if (this.activeRecorders === 0) this.deps.notifyPhase('recording');
    this.activeRecorders += 1;
  }

  private onRecorderStopped() {
    this.activeRecorders = Math.max(0, this.activeRecorders - 1);
    if (this.activeRecorders !== 0) return;

    const artifacts = [...this.finalizedArtifacts];
    this.state = 'idle';
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.tabCaptureStream = null;
    this.tabRecordingStream = null;
    this.micStream = null;
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    this.finalizedArtifacts = [];

    const resolveStop = this.resolveStop;
    this.resolveStop = null;
    this.stopPromise = null;
    resolveStop?.(artifacts);
  }

  private safeStopStream(stream: MediaStream | null) {
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  private resetRunState() {
    this.stopAllRecorders();
    this.activeRecorders = 0;
    this.tracks = [];
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.tabCaptureStream = null; this.tabRecordingStream = null; this.micStream = null;
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    this.suffix = '';
    this.micMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
    this.recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
    this.micMuted = false;
    this.cameraMuted = false;
    this.selfVideoSetMuted = null;
    this.finalizedArtifacts = [];
    this.stopPromise = null; this.resolveStop = null;
    this.pendingStartPromises = [];
  }
}
