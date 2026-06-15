/**
 * @file shared/recordingTypes.ts
 *
 * Recording domain types shared across popup, background, and offscreen
 * contexts.
 */

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'failed';
export type RecordingStream = 'tab' | 'mic' | 'self-video';
export type StorageMode = 'local' | 'drive';
export type MicMode = 'off' | 'mixed' | 'separate';

export type RecordingRunConfig = {
  storageMode: StorageMode;
  micMode: MicMode;
  recordSelfVideo: boolean;
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
  phase: RecordingPhase;
  runConfig: RecordingRunConfig | null;
  targetTabId?: number;
  meetingSlug?: string;
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
  updatedAt: number;
};
