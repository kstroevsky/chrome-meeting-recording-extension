/**
 * @file shared/recordingTypes.ts
 *
 * Recording domain types shared across popup, background, and offscreen
 * contexts.
 */

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'failed';

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
export type ObservedState = 'none' | 'starting' | 'recording' | 'stopping' | 'idle';

export type RecordingStream = 'tab' | 'mic' | 'self-video';

/**
 * An ending the user did not ask for. The capture is sealed and saved either
 * way — this is a notification of a completed save, not a decision point.
 */
export type RecordingInterruption = {
  reason: 'tab-closed' | 'navigated-away' | 'meeting-ended';
  /** Recorded position the capture actually reached. */
  atMs: number;
  /** History identity of the saved recording, so its notes can be listed. */
  historyId: string;
};
export type StorageMode = 'local' | 'drive';
export type MicMode = 'off' | 'mixed' | 'separate';
/** Immutable ownership carried with sealed artifacts after capture has ended. */
export type RecordingArtifactContext = {
  /** Random per-recording telemetry identity; never derived from history/upload identity. */
  telemetryRunId?: string;
  /** History aggregate that owns the artifacts, omitted only for legacy orphan recovery. */
  historyId?: string;
  /** Detached Drive job that owns a retry/recovery attempt. */
  uploadJobId?: string;
};
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

/** Delivered dimensions of the captured meeting-tab video track. */
export type CapturedTabResolution = {
  width?: number;
  height?: number;
};

/** Human-readable labels of the exact input devices Chrome delivered to this run. */
export type RecordingCaptureDevices = {
  microphone?: string;
  camera?: string;
};

/** Input source that can be switched while a recording is active. */
export type RecordingInputDevice = keyof RecordingCaptureDevices;

export type UploadSummaryEntry = {
  stream: RecordingStream;
  filename: string;
  bytes?: number;
  driveFileId?: string;
  webViewLink?: string;
  error?: string;
  /** Carried from capture so history can line the tracks up (see RecordingHistoryFile). */
  startOffsetMs?: number;
};

export type UploadSummary = {
  uploaded: UploadSummaryEntry[];
  localFallbacks: UploadSummaryEntry[];
  /** Stable id of the per-recording Drive folder used by every uploaded artifact. */
  driveFolderId?: string;
  /** Actual Drive folder name, kept separately from the human-facing recording title. */
  driveFolderName?: string;
  folderWebViewLink?: string;
};

/** Terminal-or-running state of one background Drive-upload job (ADR-0004). */
export type UploadJobStatus = 'uploading' | 'completed' | 'failed' | 'partial' | 'canceled';
export type RecordingNamingStatus = 'pending' | 'named' | 'skipped';

/** Per-stream file outcome shown in an upload job's detail view. */
/**
 * What an uploaded artifact *is*, orthogonal to which stream produced it. Absent
 * means media; `notes` is the WebVTT sidecar, which is delivered before the
 * media so a reader has the notes even while the video is still uploading
 * (ADR-0005).
 */
export type RecordingArtifactKind = 'notes';

export type UploadJobFile = {
  stream: RecordingStream;
  kind?: RecordingArtifactKind;
  filename: string;
  status: 'uploading' | 'uploaded' | 'fallback' | 'retry-pending' | 'unavailable';
  bytes?: number;
  driveFileId?: string;
  webViewLink?: string;
  error?: string;
  /** Carried from capture so history can line the tracks up (see RecordingHistoryFile). */
  startOffsetMs?: number;
};

/**
 * One background Drive-upload job: the sealed artifacts of a single finished
 * recording, uploaded independently of the (possibly already-restarted) recording
 * session. A job carries its own `id` because it **outlives the run that created
 * it** (ADR-0004) — the recording epoch fences capture status, jobs are keyed by
 * id — so it can keep uploading while a new recording records.
 */
export type UploadJob = {
  id: string;
  /** Stable history identity of the recording that produced this detached upload. */
  historyId?: string;
  /** Human label for the upload tab (meeting slug, or folder/timestamp fallback). */
  label: string;
  status: UploadJobStatus;
  /** Aggregate upload progress across the job's files, fraction in [0, 1]. */
  progress: number;
  /** Browser-openable Drive folder URL once the upload parent is known. */
  folderWebViewLink?: string;
  /** Stable id/name of the per-recording Drive folder for post-upload metadata changes. */
  driveFolderId?: string;
  driveFolderName?: string;
  /** One-time post-upload naming workflow state. Set only for completed uploads. */
  namingStatus?: RecordingNamingStatus;
  /** A crash-recovery attempt retained its OPFS source and will retry when the recorder runtime starts again. */
  recoveryPending?: true;
  files: UploadJobFile[];
  startedAt: number;
  /** Set once the job reaches a terminal status (completed / failed / partial). */
  finishedAt?: number;
};

/**
 * Background-owned, persisted session state. Carries control-plane bookkeeping
 * (`targetTabId`, `meetingSlug`) that only the background reads — for auto-stop
 * tab matching and survival across service-worker restarts.
 */
/**
 * One contiguous stretch of wall clock that was written into the media.
 *
 * A run is a sequence of these separated by pauses, and a paused span is never
 * written into the file — so this list, not a single origin, is what maps a
 * wall-clock instant onto a media offset. An instant that falls in no span has
 * no media position at all, which is why projection can fail.
 */
export type RecordedSpan = {
  /** Wall clock (epoch ms) when this span began recording. */
  wallStartMs: number;
  /** Wall clock when it stopped. Absent while the span is still running. */
  wallEndMs?: number;
  /** Media offset this span begins at: the recorded time banked before it. */
  mediaStartMs: number;
};

/**
 * Bound on the span ledger, following the house rule that durable lists are
 * always bounded. One span per pause/resume, so this is a runaway guard against
 * a stuck toggle rather than a product limit on how often a user may pause.
 */
export const MAX_RECORDED_SPANS = 500;

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
  /** Stable per-run recording-history identity; not exposed to the popup. */
  historyId?: string;
  /**
   * Monotonic run epoch (fencing token). Incremented on each `start()`, persisted
   * across service-worker restarts, and echoed by the offscreen in OFFSCREEN_STATE
   * so the background can drop status from a previous run. Preserved across `idle`
   * to stay strictly increasing. Background-only bookkeeping — never sent to the
   * popup. See ADR-0003.
   */
  epoch?: number;
  /**
   * Why the last run ended, when it was not the user's doing. Phase-independent
   * — it outlives the run so the popup can report the interruption after the
   * capture has already been saved (ADR-0005, design n4). Cleared on the next
   * `start()` and when the user dismisses the notice.
   */
  interruption?: RecordingInterruption;
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
   * Every contiguous stretch of wall clock this run actually wrote into the
   * media, in order. Where `recordedMs`/`runningSince` answer *how much* has
   * been recorded, this answers *which moments* — the piecewise map from wall
   * clock onto the media timeline that a transcript needs (ADR-0007).
   *
   * Phase-independent, like `epoch`: it survives the return to idle, because
   * the transcript sweep that reads it runs *after* the run has finished, and
   * is reset on the next `start()`. Bounded by {@link MAX_RECORDED_SPANS}.
   */
  recordedSpans?: RecordedSpan[];
  /**
   * Real delivered dimensions from the captured tab video track's getSettings().
   * Only meaningful while an active run exists; omitted when Chrome does not
   * expose dimensions or after the session returns to idle.
   */
  tabResolution?: CapturedTabResolution;
  /** Actual microphone/camera labels reported by the live MediaStream tracks. */
  capturedDevices?: RecordingCaptureDevices;
  /**
   * Background Drive-upload jobs that have been detached from the recording
   * session (ADR-0004). Phase-independent — a job keeps running (and stays on the
   * snapshot) while a new recording starts — and persisted so a reopened popup can
   * render in-flight uploads.
   */
  uploadJobs?: UploadJob[];
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
  /** Set when the last run ended without the user asking (design n4). */
  interruption?: RecordingInterruption;
  /** Pause-aware recording timer state; see {@link RecordingSessionSnapshot.recordedMs}. */
  recordedMs?: number;
  runningSince?: number;
  /** Real captured tab dimensions; see {@link RecordingSessionSnapshot.tabResolution}. */
  tabResolution?: CapturedTabResolution;
  /** Actual microphone/camera labels; see {@link RecordingSessionSnapshot.capturedDevices}. */
  capturedDevices?: RecordingCaptureDevices;
  /** Background Drive-upload jobs; see {@link RecordingSessionSnapshot.uploadJobs}. */
  uploadJobs?: UploadJob[];
  updatedAt: number;
};
