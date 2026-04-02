/**
 * @file offscreen/RecorderEngine.ts
 *
 * State machine facade that coordinates tab, mic, and self-video recorder tasks.
 * Stream acquisition and audio mixing are delegated to RecorderEngineSetup;
 * per-stream recording tasks live in ./engine/Tab|Mic|SelfVideoRecorderTask.
 */

import { captureTabStreamFromId } from './RecorderCapture';
import { buildRecorderRuntimeSettingsSnapshot, type RecorderRuntimeSettingsSnapshot } from '../shared/extensionSettings';
import { DEFAULT_RECORDING_RUN_CONFIG, type MicMode, type RecordingRunConfig } from '../shared/recording';
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
  RecordingArtifactFinalizePlan,
} from './engine/RecorderEngineTypes';

// Re-export types for consumers that import from the engine root.
export type {
  SealedStorageFile,
  StorageTarget,
  CompletedRecordingArtifact,
  RecordingArtifactFinalizePlan,
  RecorderEngineDeps,
} from './engine/RecorderEngineTypes';

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
  private tabFinalizePlan: RecordingArtifactFinalizePlan | null = null;
  private recorderSettings: RecorderRuntimeSettingsSnapshot | null = null;

  private suffix = '';
  private micMode: MicMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
  private recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;

  private playback: AudioPlaybackBridge | null = null;
  private mixedAudio: MixedAudioMixer | null = null;
  private stopPromise: Promise<CompletedRecordingArtifact[]> | null = null;
  private resolveStop: ((artifacts: CompletedRecordingArtifact[]) => void) | null = null;
  private finalizedArtifacts: CompletedRecordingArtifact[] = [];
  private pendingStartPromises: Promise<void>[] = [];

  constructor(deps: RecorderEngineDeps) {
    this.deps = deps;
  }

  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting' || this.state === 'stopping';
  }

  getActiveRecorderCount(): number { return this.activeRecorders; }
  getDebugState(): EngineState { return this.state; }

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
    const runStartedAt = Date.now();

    try {
      const baseStream = await captureTabStreamFromId(streamId, recorderSettings.tab.output, this.deps);
      this.tabCaptureStream = baseStream;
      logStreamAcquired(baseStream, this.deps);

      this.playback = await ensureAudiblePlayback(baseStream, this.deps);
      this.suffix = meetingSlug;
      attachTabEndedHandler(baseStream, () => this.stopAllRecorders(), this.deps.log);

      let micForRun: MediaStream | null = null;
      if (this.micMode === 'mixed' || this.micMode === 'separate') {
        micForRun = await acquireMicStream(runId, () => this.runId, () => this.state, this.micMode, recorderSettings, this.deps);
        this.micStream = micForRun;
      }

      let tabRecorderStream = baseStream;
      if (this.micMode === 'mixed') {
        const { mixer, stream } = await createMixedTabStream(baseStream, micForRun!, this.deps);
        this.mixedAudio = mixer;
        tabRecorderStream = stream;
      }
      this.tabRecordingStream = tabRecorderStream;

      const startTasks: Promise<void>[] = [
        startTabRecorder(tabRecorderStream, this.suffix, runStartedAt, this.tabFinalizePlan, recorderSettings, this.deps, {
          onStarted: () => this.onRecorderStarted(),
          onStopped: (artifact) => { if (artifact) this.finalizedArtifacts.push(artifact); this.tabRecorder = null; this.onRecorderStopped(); },
          onError: () => this.stopAllRecorders(),
        }).then((rec) => { this.tabRecorder = rec; }),
      ];

      if (this.micMode === 'separate') {
        startTasks.push(
          startMicRecorder(runId, () => this.runId, () => this.state === 'stopping' || this.state === 'idle', this.suffix, runStartedAt, this.micMode, recorderSettings, micForRun, this.deps, {
            onStarted: () => this.onRecorderStarted(),
            onStopped: (artifact) => { if (artifact) this.finalizedArtifacts.push(artifact); this.micRecorder = null; this.micStream = null; this.onRecorderStopped(); },
          }).then((rec) => { this.micRecorder = rec; }).catch((e) => this.deps.warn('Mic recorder start failed', describeMediaError(e)))
        );
      }

      if (this.recordSelfVideo) {
        startTasks.push(
          startSelfVideoRecorder(runId, () => this.runId, () => this.state === 'stopping' || this.state === 'idle', this.suffix, runStartedAt, this.recordSelfVideo, recorderSettings, this.deps, {
            onStarted: () => this.onRecorderStarted(),
            onStopped: (artifact) => { if (artifact) this.finalizedArtifacts.push(artifact); this.selfVideoRecorder = null; this.onRecorderStopped(); },
            onWarning: (msg) => this.deps.reportWarning?.(msg),
          }).then((rec) => { this.selfVideoRecorder = rec; }).catch((e) => this.deps.warn('Self video recorder start failed', describeMediaError(e)))
        );
      }

      this.pendingStartPromises = startTasks;
      await Promise.all(startTasks);
      this.pendingStartPromises = [];
      if (this.runId === runId && this.state === 'starting') this.state = 'recording';
    } catch (e) {
      this.state = 'idle';
      this.resetRunState();
      throw e;
    }
  }

  async stop(): Promise<CompletedRecordingArtifact[]> {
    if (!this.tabRecorder || !this.isRecording()) {
      this.deps.warn('Stop called but not recording');
      return Promise.resolve([]);
    }
    if (this.stopPromise) return this.stopPromise;

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
    return this.stopPromise;
  }

  revokeBlobUrl(blobUrl: string) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }

  private stopAllRecorders() {
    try { this.tabRecorder?.stop(); } catch (e) { this.deps.error('Tab stop error', describeMediaError(e)); }
    try { this.micRecorder?.stop(); } catch (e) { this.deps.error('Mic stop error', describeMediaError(e)); }
    try { this.selfVideoRecorder?.stop(); } catch (e) { this.deps.error('Self video stop error', describeMediaError(e)); }
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
    this.recorderSettings = null;
    this.finalizedArtifacts = [];
    this.tabFinalizePlan = null;

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
    this.tabRecorder = null; this.micRecorder = null; this.selfVideoRecorder = null;
    this.safeStopStream(this.tabCaptureStream);
    this.safeStopStream(this.tabRecordingStream);
    this.safeStopStream(this.micStream);
    this.tabCaptureStream = null; this.tabRecordingStream = null; this.micStream = null;
    this.playback?.stop(); this.playback = null;
    this.mixedAudio?.stop(); this.mixedAudio = null;
    this.suffix = '';
    this.micMode = DEFAULT_RECORDING_RUN_CONFIG.micMode;
    this.recordSelfVideo = DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
    this.recorderSettings = null;
    this.finalizedArtifacts = [];
    this.tabFinalizePlan = null;
    this.stopPromise = null; this.resolveStop = null;
    this.pendingStartPromises = [];
  }
}
