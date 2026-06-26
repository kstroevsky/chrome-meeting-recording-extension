/**
 * @file shared/recordingTypes.ts
 *
 * Recording domain types shared across popup, background, and offscreen
 * contexts.
 */

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'failed';

/**
 * Command-plane intent (ADR-0003, Decision 4): what the background *wants* the
 * recording to be doing. Written only by the command path (`start` ⇒ `recording`,
 * `stop` / finalize ⇒ `idle`). One of the two inputs from which the displayed
 * {@link RecordingPhase} is derived; see `projectPhase`.
 */
export type DesiredState = 'idle' | 'recording';

/**
 * Status-plane observation (ADR-0003, Decision 4): the last phase the offscreen
 * recorder reported about itself via OFFSCREEN_STATE, or `none` before it has
 * reported anything. Written only by the offscreen-status path. The second input
 * to the derived {@link RecordingPhase}. Failure is tracked separately (a terminal
 * flag set by either plane), so it is not represented as an observed value here.
 */
export type ObservedState = 'none' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'idle';

export type RecordingStream = 'tab' | 'mic' | 'self-video';
export type StorageMode = 'local' | 'drive';
export type MicMode = 'off' | 'mixed' | 'separate';
/** Tab recording quality preset: 'screen' (UI/code/slides) vs 'video' (playback/motion). */
export type TabContentType = 'screen' | 'video';

export type RecordingRunConfig = {
  storageMode: StorageMode;
  micMode: MicMode;
  recordSelfVideo: boolean;
  /**
   * Per-recording tab content preset, chosen in the popup before each recording.
   * Optional on the type to keep the many run-config literals churn-free; the
   * canonical paths (`parseRunConfig`, `DEFAULT_RECORDING_RUN_CONFIG`) always set it.
   */
  tabContentType?: TabContentType;
};

export type UploadSummaryEntry = {
  stream: RecordingStream;
  filename: string;
  error?: string;
};

export type UploadSummary = {
  uploaded: UploadSummaryEntry[];
  localFallbacks: UploadSummaryEntry[];
};

/**
 * Background-owned, persisted session state. Carries control-plane bookkeeping
 * (`targetTabId`, `meetingSlug`) that only the background reads — for auto-stop
 * tab matching and survival across service-worker restarts.
 */
export type RecordingSessionSnapshot = {
  /**
   * Displayed recording phase. **Derived** (ADR-0003, Decision 4): always equal
   * to `projectPhase(desired, observed, failed)`. It is never written directly —
   * mutate the two planes below (plus `failed`) and the phase follows. Kept on the
   * snapshot rather than recomputed on read so every consumer and the persisted
   * blob observe one consistent value.
   */
  phase: RecordingPhase;
  /**
   * Command-plane intent: what the background *wants* the recording to be doing.
   * Written only by the command path (`start` ⇒ `recording`; `stop` / finalize ⇒
   * `idle`). Optional only for backward compatibility with pre-Decision-4 persisted
   * snapshots; current code always sets it. See {@link DesiredState}.
   */
  desired?: DesiredState;
  /**
   * Status-plane observation: the recorder's last known state — seeded to
   * `starting` when a run is launched and thereafter overwritten only by offscreen
   * OFFSCREEN_STATE reports. The command path never writes it, so a stale status
   * can no longer overwrite intent. See {@link ObservedState}.
   */
  observed?: ObservedState;
  /**
   * Terminal failure flag. Set by either plane (`fail()` in the command path or an
   * observed `failed`) and wins over `desired`/`observed` in the projection. Cleared
   * on the next `start()` / finalize.
   */
  failed?: boolean;
  runConfig: RecordingRunConfig | null;
  targetTabId?: number;
  meetingSlug?: string;
  /**
   * Monotonic run epoch (fencing token). Incremented on each `start()`, persisted
   * across service-worker restarts, and echoed by the offscreen in OFFSCREEN_STATE
   * so the background can drop status from a previous run. Preserved across `idle`
   * to stay strictly increasing. Background-only bookkeeping — never sent to the
   * popup. See ADR-0003.
   */
  epoch?: number;
  uploadSummary?: UploadSummary;
  error?: string;
  warnings?: string[];
  /**
   * Live mic-mute state during an active recording. The mic keeps flowing but
   * its track emits silence (see RecorderEngine.setMicMuted). Omitted/false
   * means the mic is live; only meaningful while `runConfig.micMode !== 'off'`.
   */
  micMuted?: boolean;
  /**
   * Live camera-hidden state during an active self-video recording. The camera
   * keeps flowing but its track emits black frames (see RecorderEngine.setCameraMuted).
   * Omitted/false means the camera is live; only meaningful while `runConfig.recordSelfVideo`.
   */
  cameraMuted?: boolean;
  /**
   * Live pause state of the whole recording. While paused, every MediaRecorder
   * is paused so nothing is written (see RecorderEngine.setPaused); the tracks
   * stay live so resume produces a seamless join. Omitted/false means actively
   * recording; only meaningful while the session is in an active capture phase.
   */
  paused?: boolean;
  /**
   * Pause-aware recording timer state. `recordedMs` is the accumulated *recorded*
   * duration (excludes paused spans), frozen on pause and on stop; `runningSince`
   * is the epoch ms the timer (re)started counting, or omitted while paused /
   * stopped / idle. Live elapsed = recordedMs + (runningSince ? now - runningSince : 0).
   * Authoritative here so the disposable popup can render a correct timer after reopen.
   */
  recordedMs?: number;
  runningSince?: number;
  /**
   * Live Drive-upload progress as a fraction in [0, 1] while `phase === 'uploading'`.
   * Mirrors the offscreen's throttled OFFSCREEN_STATE progress so a reopened popup
   * renders a determinate ring. Omitted in every other phase. See ADR-0003.
   */
  uploadProgress?: number;
  updatedAt: number;
};

/**
 * Popup-facing projection of a session snapshot. Drops the control-plane
 * bookkeeping the popup never renders. This is what crosses the wire to the
 * popup; produce it with `toStatusView`.
 */
export type RecordingStatusView = {
  phase: RecordingPhase;
  runConfig: RecordingRunConfig | null;
  uploadSummary?: UploadSummary;
  error?: string;
  warnings?: string[];
  /** Live mic-mute state; see {@link RecordingSessionSnapshot.micMuted}. */
  micMuted?: boolean;
  /** Live camera-hidden state; see {@link RecordingSessionSnapshot.cameraMuted}. */
  cameraMuted?: boolean;
  /** Live whole-recording pause state; see {@link RecordingSessionSnapshot.paused}. */
  paused?: boolean;
  /** Pause-aware recording timer state; see {@link RecordingSessionSnapshot.recordedMs}. */
  recordedMs?: number;
  runningSince?: number;
  /** Live Drive-upload progress; see {@link RecordingSessionSnapshot.uploadProgress}. */
  uploadProgress?: number;
  updatedAt: number;
};
