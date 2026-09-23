/**
 * @file offscreen/RecorderEngine.ts
 *
 * State machine facade that coordinates tab, mic, and self-video recorder tasks.
 * Stream acquisition and audio mixing are delegated to RecorderEngineSetup;
 * per-stream recording tasks live in ./engine/Tab|Mic|SelfVideoRecorderTask.
 */

import {
  captureTabStreamFromId,
  maybeGetMicStream,
  maybeGetSelfVideoStream,
  triggerE2EMockTabMarker,
} from './RecorderCapture';
import { buildRecorderRuntimeSettingsSnapshot, type RecorderRuntimeSettingsSnapshot } from '../shared/settings';
import { DEFAULT_RECORDING_RUN_CONFIG, isStoppablePhase, type CapturedTabResolution, type MicMode, type RecordingCaptureDevices, type RecordingInputDevice, type RecordingRunConfig, type RecordingStream } from '../shared/recording';
import { describeMediaError } from './RecorderSupport';
import { SwitchableAudioInput, type MixedAudioMixer } from './RecorderAudio';
import type { AudioPlaybackBridge } from './RecorderAudio';

import { startTabRecorder } from './engine/TabRecorderTask';
import { startMicRecorder } from './engine/MicRecorderTask';
import { startSelfVideoRecorder } from './engine/SelfVideoRecorderTask';
import { getCameraRecordingProfile, getMicrophoneRecordingProfile, getTabRecordingProfile } from './RecorderProfiles';
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

type DefaultInputDevice = {
  deviceId: string;
  label: string;
};

// Chrome resolves this virtual audio-input id to the current browser/OS default.
// Unlike a physical id, it remains valid when macOS changes its default input.
const DEFAULT_MICROPHONE_DEVICE_ID = 'default';

export class RecorderEngine {
  private readonly deps: RecorderEngineDeps;

  private state: EngineState = 'idle';
  private activeRecorders = 0;
  private runId = 0;

  private tracks: RecorderTrack[] = [];

  private tabCaptureStream: MediaStream | null = null;
  private tabRecordingStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private micInput: SwitchableAudioInput | null = null;
  private selfVideoReplaceSource: ((track: MediaStreamTrack) => Promise<void>) | null = null;
  private tabResolution: CapturedTabResolution | undefined;
  private recorderSettings: RecorderRuntimeSettingsSnapshot | null = null;
  private defaultInputDevices: Partial<Record<RecordingInputDevice, DefaultInputDevice>> = {};
  private followsDefaultInput: Record<RecordingInputDevice, boolean> = {
    microphone: true,
    camera: true,
  };
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;

  private suffix = '';
  private micMode: MicMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
  private recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
  private micMuted = false;
  private cameraMuted = false;
  private paused = false;
  private selfVideoSetMuted: ((muted: boolean) => void) | null = null;
  private selfVideoSetPaused: ((paused: boolean) => void) | null = null;

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
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.scheduleDefaultInputRefresh());
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

  /** Switches a live input in place so its MediaRecorder keeps the same continuous track. */
  async setInputDevice(device: RecordingInputDevice, deviceId: string): Promise<string> {
    const label = await this.switchInputDevice(device, deviceId);
    // A physical picker choice pins this input for the rest of the run. Choosing
    // Chrome's virtual default alias explicitly keeps follow-default mode active.
    this.followsDefaultInput[device] = device === 'microphone'
      && deviceId === DEFAULT_MICROPHONE_DEVICE_ID;
    return label;
  }

  private async switchInputDevice(device: RecordingInputDevice, deviceId: string): Promise<string> {
    if (this.state !== 'recording') throw new Error('Input device can only be changed while recording');
    const settings = this.recorderSettings;
    if (!settings) throw new Error('Recorder settings are unavailable');

    let replacement: MediaStream | null;
    let track: MediaStreamTrack | undefined;
    if (device === 'microphone') {
      if (!this.micInput) throw new Error('Live microphone switching is unavailable in this browser');
      replacement = await maybeGetMicStream(this.micMode, settings.microphone, this.deps, deviceId);
      track = replacement?.getAudioTracks()[0];
      if (!replacement || !track) throw new Error('Could not open the selected microphone');
      try {
        await this.micInput.replaceSource(replacement);
      } catch (error) {
        this.safeStopStream(replacement);
        throw error;
      }
    } else {
      if (!this.selfVideoReplaceSource) throw new Error('Live camera switching is unavailable in this browser');
      replacement = await maybeGetSelfVideoStream(true, settings.selfVideo.profile, this.deps, deviceId);
      track = replacement?.getVideoTracks()[0];
      if (!replacement || !track) throw new Error('Could not open the selected camera');
      try {
        await this.selfVideoReplaceSource(track);
      } catch (error) {
        this.safeStopStream(replacement);
        throw error;
      }
    }

    const label = await this.resolveCapturedDeviceLabel(device, track, deviceId);
    this.deps.reportCaptureDevices?.({ [device]: label });
    return label;
  }

  /** Debounces the burst of devicechange events emitted while a headset connects. */
  private scheduleDefaultInputRefresh(): void {
    if (this.state !== 'recording') return;
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null;
      void this.refreshDefaultInputDevices();
    }, 200);
  }

  /** Follows a newly-selected OS/browser default unless the user pinned an input. */
  private async refreshDefaultInputDevices(): Promise<void> {
    if (this.state !== 'recording') return;
    const nextDefaults = await this.resolveDefaultInputDevices();

    // `devicechange` is the reliable signal here; device enumeration in an
    // offscreen document may still hide ids or labels. Reopening the virtual
    // alias makes Chrome resolve whichever input is default now.
    if (this.followsDefaultInput.microphone && this.micMode !== 'off') {
      try {
        const label = await this.switchInputDevice('microphone', DEFAULT_MICROPHONE_DEVICE_ID);
        this.defaultInputDevices.microphone = {
          deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
          label,
        };
        this.deps.log('Followed new default microphone:', label);
      } catch (error) {
        this.deps.warn('Could not follow new default microphone', describeMediaError(error));
      }
    }

    if (!this.followsDefaultInput.camera || !this.recordSelfVideo) return;
    const previousCamera = this.defaultInputDevices.camera;
    const nextCamera = nextDefaults.camera;
    if (!nextCamera || (previousCamera?.deviceId === nextCamera.deviceId && previousCamera.label === nextCamera.label)) return;
    try {
      await this.switchInputDevice('camera', nextCamera.deviceId);
      this.defaultInputDevices.camera = nextCamera;
      this.deps.log('Followed new default camera:', nextCamera.label || nextCamera.deviceId);
    } catch (error) {
      this.deps.warn('Could not follow new default camera', describeMediaError(error));
    }
  }

  /** Uses Chrome's live microphone alias; enumeration remains camera-only metadata. */
  private async resolveDefaultInputDevices(): Promise<Partial<Record<RecordingInputDevice, DefaultInputDevice>>> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const first = (kind: MediaDeviceKind): DefaultInputDevice | undefined => {
        const device = devices.find((candidate) => candidate.kind === kind && candidate.deviceId);
        return device ? { deviceId: device.deviceId, label: device.label } : undefined;
      };
      return {
        microphone: {
          deviceId: DEFAULT_MICROPHONE_DEVICE_ID,
          label: first('audioinput')?.label ?? '',
        },
        camera: first('videoinput'),
      };
    } catch (error) {
      this.deps.warn('Could not resolve current default capture devices', describeMediaError(error));
      return {
        microphone: { deviceId: DEFAULT_MICROPHONE_DEVICE_ID, label: '' },
      };
    }
  }

  /**
   * Pauses or resumes the whole recording. Drives `MediaRecorder.pause()/resume()`
   * on every active recorder: the paused span is never gathered into the blob, so
   * resume produces a seamless join (no black/blank filler) — unlike a mute, which
   * would record silence/black for the full span. Tracks stay live, so resume is
   * instant and the timeline stays continuous. The desired state is remembered so
   * a pause toggled during the `starting` phase is applied to recorders as they
   * come up (see registerTrack).
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyPauseState();
  }

  private applyPauseState(): void {
    const paused = this.paused;

    // On resume, restart upstream producers before the recorders so audio/frames
    // are already flowing when each recorder resumes gathering.
    if (!paused) {
      this.selfVideoSetPaused?.(false);
      this.micInput?.resume();
      this.mixedAudio?.resume();
    }

    for (const track of this.tracks) {
      try {
        if (paused) {
          if (track.recorder.state === 'recording') track.recorder.pause();
        } else if (track.recorder.state === 'paused') {
          track.recorder.resume();
        }
      } catch (e) {
        this.deps.error(`${track.stream} pause/resume error`, describeMediaError(e));
      }
    }

    // On pause, idle upstream producers after the recorders are paused — nothing
    // is being gathered, so the mixing/resize work is pure waste until resume.
    if (paused) {
      this.selfVideoSetPaused?.(true);
      this.micInput?.suspend();
      this.mixedAudio?.suspend();
    }
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
    this.recorderSettings = recorderSettings;
    this.suffix = meetingSlug;
    const runStartedAt = nowMs();
    debugPerf(this.deps.log, 'lifecycle', 'start_requested', {
      activeTracks: this.tracks.length,
      micMode: options.micMode,
      recordSelfVideo: options.recordSelfVideo,
      storageMode: options.storageMode,
    });

    try {
      this.assertActiveOutputFormatsSupported(options, recorderSettings);
      this.defaultInputDevices = await this.resolveDefaultInputDevices();
      const tabRecorderStream = await this.acquireRecordingStreams(streamId, options, recorderSettings, runId);
      // A stop/discard may arrive while capture permissions or a device are still
      // resolving. Never start a recorder after that command; release the just-
      // acquired tracks instead of leaving a late camera/mic/tab capture alive.
      if (this.runId !== runId || this.state !== 'starting') {
        this.safeStopStream(tabRecorderStream);
        return;
      }
      const startTasks = this.buildRecorderStartTasks(tabRecorderStream, runId, runStartedAt, recorderSettings);
      this.pendingStartPromises = startTasks;
      await Promise.all(startTasks);
      this.pendingStartPromises = [];
      if (this.runId === runId && this.state === 'starting') {
        this.state = 'recording';
        triggerE2EMockTabMarker(this.tabCaptureStream);
      }
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

  /** Rejects stale persisted format selections before opening any capture devices. */
  private assertActiveOutputFormatsSupported(options: RecordingRunConfig, recorderSettings: RecorderRuntimeSettingsSnapshot): void {
    const tabFormat = recorderSettings.tab.output.format;
    if (!getTabRecordingProfile(tabFormat, true)) {
      throw new Error(`The selected ${tabFormat.toUpperCase()} tab format is unavailable. Change it in Settings and try again.`);
    }
    if (options.recordSelfVideo && !getCameraRecordingProfile(recorderSettings.selfVideo.profile.format)) {
      throw new Error(`The selected ${recorderSettings.selfVideo.profile.format.toUpperCase()} camera format is unavailable. Change it in Settings and try again.`);
    }
    if (options.micMode === 'separate' && !getMicrophoneRecordingProfile(recorderSettings.microphone.format)) {
      throw new Error(`The selected ${recorderSettings.microphone.format.toUpperCase()} microphone format is unavailable. Change it in Settings and try again.`);
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
    this.tabResolution = RecorderEngine.readTabResolution(baseStream);
    logStreamAcquired(baseStream, this.deps);

    this.playback = await ensureAudiblePlayback(baseStream, this.deps);
    attachTabEndedHandler(baseStream, () => this.stopAllRecorders(), this.deps.log);

    if (options.micMode === 'mixed' || options.micMode === 'separate') {
      const source = await acquireMicStream(
        runId,
        () => this.runId,
        () => this.state,
        options.micMode,
        recorderSettings,
        this.deps,
        this.defaultInputDevices.microphone?.deviceId,
      );
      this.reportCapturedDevice('microphone', source.getAudioTracks()[0]);
      const bridge = new SwitchableAudioInput();
      try {
        this.micStream = await bridge.create(source);
        this.micInput = bridge;
      } catch (error) {
        bridge.stop();
        this.deps.warn('Switchable microphone bridge unavailable; using direct input', describeMediaError(error));
        this.micStream = source;
        this.micInput = null;
      }
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
          onStopped: (artifact) => {
            // Stop the mic *source* track here, before nulling the ref. A separate
            // mic's getUserMedia stream is owned by the engine (MicRecorderTask only
            // stops it on a stale/discard), and stopping the MediaRecorder does NOT
            // stop its source track. Nulling `micStream` before onRecorderStopped's
            // cleanup runs would leave the device open — the mic indicator stays lit
            // after the recording ends. safeStopStream is idempotent, so this is safe
            // even when stopStream() already released it.
            this.micInput?.stop();
            this.micInput = null;
            this.safeStopStream(this.micStream);
            this.micStream = null;
            this.onTrackStopped('mic', artifact);
          },
        }).then((recorder) => { if (recorder) this.registerTrack({ stream: 'mic', recorder }); })
          .catch((e) => this.deps.warn('Mic recorder start failed', describeMediaError(e)))
      );
    }

    if (this.recordSelfVideo) {
      let stopStream: (() => void) | undefined;
      tasks.push(
        startSelfVideoRecorder(runId, () => this.runId, isStale, this.suffix, runStartedAt, this.recordSelfVideo, recorderSettings, this.deps, this.defaultInputDevices.camera?.deviceId, {
          onStarted: () => this.onRecorderStarted(),
          onStopped: (artifact) => { this.selfVideoReplaceSource = null; this.selfVideoSetMuted = null; this.selfVideoSetPaused = null; this.onTrackStopped('self-video', artifact); },
          onWarning: (msg) => this.deps.reportWarning?.(msg),
          onStreamAcquired: (controls) => {
            this.selfVideoReplaceSource = controls.replaceSource ?? null;
            this.reportCapturedDevice('camera', controls.track);
            stopStream = controls.stop;
            this.selfVideoSetMuted = controls.setMuted;
            this.selfVideoSetPaused = controls.setPaused;
            controls.setMuted(this.cameraMuted);
            controls.setPaused(this.paused);
          },
        }).then((recorder) => { if (recorder) this.registerTrack({ stream: 'self-video', recorder, stopStream }); })
          .catch((e) => this.deps.warn('Self video recorder start failed', describeMediaError(e)))
      );
    }

    return tasks;
  }

  async stop(): Promise<CompletedRecordingArtifact[]> {
    if (!this.isRecording()) {
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

    // A stop/discard during startup can legitimately beat every recorder's
    // `onstart`. Complete the lifecycle anyway so acquired device tracks and all
    // references are released instead of waiting forever for an onstop callback.
    if (!this.tracks.length) {
      this.completeStop();
      return this.stopPromise ?? Promise.resolve([]);
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
    if (stream === 'mic') {
      this.micInput?.stop();
      this.micInput = null;
      this.safeStopStream(this.micStream);
    }
    try { track.recorder.stop(); } catch (e) { this.deps.error(`${stream} stop error`, describeMediaError(e)); }
  }

  /** Adds a started recorder to the active track set. */
  private registerTrack(track: RecorderTrack): void {
    this.tracks.push(track);
    // Apply a pause toggled during the `starting` phase to recorders as they come
    // up, so all streams pause together regardless of acquisition order/timing.
    if (this.paused && track.recorder.state === 'recording') {
      try { track.recorder.pause(); } catch (e) { this.deps.error(`${track.stream} pause error`, describeMediaError(e)); }
    }
  }

  /** Collects a stopped track's artifact, drops it from the set, then advances stop accounting. */
  private onTrackStopped(stream: RecordingStream, artifact: CompletedRecordingArtifact | null): void {
    if (artifact) this.finalizedArtifacts.push(artifact);
    this.tracks = this.tracks.filter((track) => track.stream !== stream);
    this.onRecorderStopped();
  }

  private onRecorderStarted() {
    if (this.activeRecorders === 0) this.deps.notifyPhase('recording', { tabResolution: this.tabResolution });
    this.activeRecorders += 1;
  }

  /** Publishes the label Chrome exposed for the exact live MediaStreamTrack it selected. */
  private reportCapturedDevice(device: keyof RecordingCaptureDevices, track?: MediaStreamTrack): void {
    const label = track?.label?.trim() || 'Device name unavailable';
    this.deps.reportCaptureDevices?.({ [device]: label });
  }

  /** Resolves the chosen device label from the exact ID used for reacquisition. */
  private async resolveCapturedDeviceLabel(
    device: RecordingInputDevice,
    track: MediaStreamTrack,
    requestedDeviceId: string,
  ): Promise<string> {
    const trackLabel = track.label?.trim();
    if (trackLabel) return trackLabel;
    try {
      const kind = device === 'microphone' ? 'audioinput' : 'videoinput';
      const match = (await navigator.mediaDevices.enumerateDevices())
        .find((candidate) => candidate.kind === kind && candidate.deviceId === requestedDeviceId);
      if (match?.label.trim()) return match.label.trim();
    } catch {}
    return 'Device name unavailable';
  }

  private onRecorderStopped() {
    this.activeRecorders = Math.max(0, this.activeRecorders - 1);
    if (this.activeRecorders !== 0) return;

    this.completeStop();
  }

  /** Releases every capture-side resource and resolves the pending stop exactly once. */
  private completeStop() {
    const artifacts = [...this.finalizedArtifacts];
    this.state = 'idle';
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.micInput?.stop(); this.micInput = null;
    this.selfVideoReplaceSource = null;
    this.tabCaptureStream = null;
    this.tabRecordingStream = null;
    this.micStream = null;
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    this.recorderSettings = null;
    this.clearDefaultInputTracking();
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
    this.micInput?.stop(); this.micInput = null;
    this.selfVideoReplaceSource = null;
    this.tabCaptureStream = null; this.tabRecordingStream = null; this.micStream = null;
    this.tabResolution = undefined;
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    this.suffix = '';
    this.micMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
    this.recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
    this.recorderSettings = null;
    this.clearDefaultInputTracking();
    this.micMuted = false;
    this.cameraMuted = false;
    this.paused = false;
    this.selfVideoSetMuted = null;
    this.selfVideoSetPaused = null;
    this.finalizedArtifacts = [];
    this.stopPromise = null; this.resolveStop = null;
    this.pendingStartPromises = [];
  }

  private clearDefaultInputTracking(): void {
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = null;
    this.defaultInputDevices = {};
    this.followsDefaultInput = { microphone: true, camera: true };
  }

  private static readTabResolution(stream: MediaStream): CapturedTabResolution | undefined {
    const settings = stream.getVideoTracks()[0]?.getSettings?.();
    const width = typeof settings?.width === 'number' && settings.width > 0 ? Math.round(settings.width) : undefined;
    const height = typeof settings?.height === 'number' && settings.height > 0 ? Math.round(settings.height) : undefined;
    return width != null || height != null ? { width, height } : undefined;
  }
}
