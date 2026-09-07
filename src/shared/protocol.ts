/**
 * @file shared/protocol.ts
 *
 * Single source of truth for all inter-context message contracts in the
 * extension.
 */

import type { MeetingProviderInfo } from './provider';
import type { RecordingNotation, RecordingNotationSummary } from './notations';
import type { RecorderRuntimeSettingsSnapshot } from './settings';
import type { PerfSettings } from './perf';
import type {
  RecordingRunConfig,
  RecordingStatusView,
  RecordingPhase,
  RecordingCaptureDevices,
  RecordingInputDevice,
  CapturedTabResolution,
  UploadJob,
  UploadSummary,
} from './recording';
import {
  BG_TO_OFFSCREEN_RUNTIME_CONNECT,
  CONTENT_TO_BG_MESSAGE_TYPES,
  OFFSCREEN_TO_BG_MESSAGE_TYPES,
  PERF_EVENT_MESSAGE_TYPE,
  POPUP_TO_BG_MESSAGE_TYPES,
  POPUP_TO_CONTENT_MESSAGE_TYPES,
} from './protocolMessageTypes';
import { getMessageType, hasKnownMessageType } from './typeGuards';
import type { RecordingHistoryCursor, RecordingHistoryEntry } from './recordingHistory';

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };
export type RpcResponse<T = unknown> = { __respFor: RpcId; payload: T };

export type CommandResult =
  | { ok: true; session: RecordingStatusView }
  | { ok: false; error: string; session: RecordingStatusView };

/**
 * Notation command results. Deliberately *not* a {@link CommandResult}: a
 * failed notation write is a data-plane error, not a capture failure, so it must
 * never carry (or fail) the recording session.
 */
export type NotationResult =
  | { ok: true; notation: RecordingNotation }
  | { ok: false; error: string };

export type NotationListResult =
  | { ok: true; notations: RecordingNotation[] }
  | { ok: false; error: string };

export type DriveTokenResponse =
  | { ok: true; token: string }
  | { ok: false; error: string };

export type PopupStartRecording = {
  type: 'START_RECORDING';
  tabId: number;
  runConfig: RecordingRunConfig;
};

export type PopupStopRecording = { type: 'STOP_RECORDING' };
/** Stops the active capture and permanently deletes its temporary media artifacts. */
export type PopupDiscardRecording = { type: 'DISCARD_RECORDING' };
export type PopupGetRecordingStatus = { type: 'GET_RECORDING_STATUS' };
export type PopupGetDriveToken = { type: 'GET_DRIVE_TOKEN'; refresh?: boolean };
/** Toggles microphone mute on the live recording; the mic emits silence while muted. */
export type PopupSetMicMuted = { type: 'SET_MIC_MUTED'; muted: boolean };
/** Toggles the camera on the live self-video recording; it emits black frames while hidden. */
export type PopupSetCameraMuted = { type: 'SET_CAMERA_MUTED'; muted: boolean };
/** Switches the live microphone or camera track to a different enumerated input. */
export type PopupSetInputDevice = { type: 'SET_INPUT_DEVICE'; device: RecordingInputDevice; deviceId: string };
/** Pauses/resumes the whole recording; the paused span is absent from the files (seamless join). */
export type PopupSetPaused = { type: 'SET_PAUSED'; paused: boolean };
/** Dismisses a finished background upload job's tab (ADR-0004). */
export type PopupDismissUploadJob = { type: 'DISMISS_UPLOAD_JOB'; jobId: string };
/** Retries a failed/partial background upload job (ADR-0004). */
export type PopupRetryUploadJob = { type: 'RETRY_UPLOAD_JOB'; jobId: string };
/** Cancels an active Drive upload and downloads every unfinished file locally. */
export type PopupCancelUploadJob = { type: 'CANCEL_UPLOAD_JOB'; jobId: string };
/** Marks the one-time completed-upload naming prompt handled without renaming. */
export type PopupSkipRecordingNaming = { type: 'SKIP_RECORDING_NAMING'; jobId: string };
/** Clears the interrupted-run notice once the user has seen it (design n4). */
export type PopupDismissInterruption = { type: 'DISMISS_INTERRUPTION' };
/** Reads one bounded, newest-first page of recording history. */
export type PopupListRecordingHistory = { type: 'LIST_RECORDING_HISTORY'; cursor?: RecordingHistoryCursor };
export type PopupRenameRecordingHistory = { type: 'RENAME_RECORDING_HISTORY'; id: string; name: string };
export type PopupSetRecordingHistoryNote = { type: 'SET_RECORDING_HISTORY_NOTE'; id: string; note: string };
export type PopupRemoveRecordingHistory = { type: 'REMOVE_RECORDING_HISTORY'; id: string };
export type PopupOpenRecordingHistoryFile = { type: 'OPEN_RECORDING_HISTORY_FILE'; recordingId: string; fileId: string };

/** Stamps a notation at the live recording position (ADR-0005). Targets the active run. */
export type PopupMarkNotation = { type: 'MARK_NOTATION'; text?: string };
/** Closes an open notation at the live recording position. Targets the active run. */
export type PopupEndNotation = { type: 'END_NOTATION'; id: string };
export type PopupListActiveNotations = { type: 'LIST_ACTIVE_NOTATIONS' };
export type PopupUpdateActiveNotation = { type: 'UPDATE_ACTIVE_NOTATION'; id: string; text: string };
export type PopupRemoveActiveNotation = { type: 'REMOVE_ACTIVE_NOTATION'; id: string };
export type PopupListRecordingNotations = { type: 'LIST_RECORDING_NOTATIONS'; recordingId: string };
/** Files a finished recording into one of the user's destinations; null unfiles it. */
export type PopupFileRecordingToDestination = {
  type: 'FILE_RECORDING_TO_DESTINATION';
  recordingId: string;
  presetId: string | null;
};
/** Recordings whose bytes are in the library but not yet written to Downloads. */
/** Storage the retained library occupies, and whether it is safe from eviction. */
export type PopupGetStorageUsage = { type: 'GET_STORAGE_USAGE' };
export type PopupListPendingLocalDeliveries = { type: 'LIST_PENDING_LOCAL_DELIVERIES' };
/** Writes a deferred local recording into the chosen folder; null means Downloads itself. */
export type PopupDeliverLocalRecording = {
  type: 'DELIVER_LOCAL_RECORDING';
  recordingId: string;
  folderId: string | null;
};
export type PopupGetPlaybackManifest = { type: 'GET_RECORDING_PLAYBACK_MANIFEST'; recordingId: string };
/**
 * Note what is absent: no `tabId`. Background reads it from `sender`, because a
 * page that could name its own tab could ask for Drive credentials to be
 * installed into someone else's (ADR-0006 §12).
 */
export type PopupPreparePlaybackSource = {
  type: 'PREPARE_RECORDING_PLAYBACK_SOURCE';
  recordingId: string;
  fileId: string;
  source: 'drive';
};
export type PopupRefreshPlaybackSource = {
  type: 'REFRESH_RECORDING_PLAYBACK_SOURCE';
  recordingId: string;
  fileId: string;
};
/** Adds a notation to a finished recording at an explicit media offset. */
export type PopupAddRecordingNotation = {
  type: 'ADD_RECORDING_NOTATION';
  recordingId: string;
  tStartMs: number;
  tEndMs?: number;
  text: string;
};
export type PopupListRecordingNotationSummaries = { type: 'LIST_RECORDING_NOTATION_SUMMARIES'; recordingIds: string[] };
export type PopupUpdateRecordingNotation = {
  type: 'UPDATE_RECORDING_NOTATION';
  recordingId: string;
  id: string;
  tStartMs?: number;
  tEndMs?: number;
  text?: string;
};
export type PopupRemoveRecordingNotation = { type: 'REMOVE_RECORDING_NOTATION'; recordingId: string; id: string };

export type PopupToBg =
  | PopupStartRecording
  | PopupStopRecording
  | PopupDiscardRecording
  | PopupGetRecordingStatus
  | PopupGetDriveToken
  | PopupSetMicMuted
  | PopupSetCameraMuted
  | PopupSetInputDevice
  | PopupSetPaused
  | PopupDismissUploadJob
  | PopupRetryUploadJob
  | PopupCancelUploadJob
  | PopupSkipRecordingNaming
  | PopupDismissInterruption
  | PopupListRecordingHistory
  | PopupRenameRecordingHistory
  | PopupSetRecordingHistoryNote
  | PopupRemoveRecordingHistory
  | PopupOpenRecordingHistoryFile
  | PopupMarkNotation
  | PopupEndNotation
  | PopupListActiveNotations
  | PopupUpdateActiveNotation
  | PopupRemoveActiveNotation
  | PopupListRecordingNotations
  | PopupGetPlaybackManifest
  | PopupFileRecordingToDestination
  | PopupGetStorageUsage
  | PopupListPendingLocalDeliveries
  | PopupDeliverLocalRecording
  | PopupPreparePlaybackSource
  | PopupRefreshPlaybackSource
  | PopupListRecordingNotationSummaries
  | PopupAddRecordingNotation
  | PopupUpdateRecordingNotation
  | PopupRemoveRecordingNotation;

export type PopupToBgResponse<T extends PopupToBg> =
  T extends PopupStartRecording ? CommandResult :
  T extends PopupStopRecording ? CommandResult :
  T extends PopupDiscardRecording ? CommandResult :
  T extends PopupGetRecordingStatus ? { session: RecordingStatusView } :
  T extends PopupGetDriveToken ? DriveTokenResponse :
  T extends PopupSetMicMuted ? CommandResult :
  T extends PopupSetCameraMuted ? CommandResult :
  T extends PopupSetInputDevice ? CommandResult :
  T extends PopupSetPaused ? CommandResult :
  T extends PopupDismissUploadJob ? { session: RecordingStatusView } :
  T extends PopupRetryUploadJob ? CommandResult :
  T extends PopupCancelUploadJob ? CommandResult :
  T extends PopupListRecordingHistory ? { ok: true; entries: RecordingHistoryEntry[]; nextCursor?: RecordingHistoryCursor } | { ok: false; error: string } :
  T extends PopupRenameRecordingHistory ? { ok: true; entry?: RecordingHistoryEntry; session?: RecordingStatusView } | { ok: false; error: string } :
  T extends PopupSkipRecordingNaming ? CommandResult :
  T extends PopupDismissInterruption ? { session: RecordingStatusView } :
  T extends PopupSetRecordingHistoryNote ? { ok: true; entry?: RecordingHistoryEntry } | { ok: false; error: string } :
  T extends PopupRemoveRecordingHistory ? { ok: true; removed: boolean } | { ok: false; error: string } :
  T extends PopupOpenRecordingHistoryFile ? { ok: true } | { ok: false; error: string } :
  T extends PopupMarkNotation ? NotationResult :
  T extends PopupEndNotation ? NotationResult :
  T extends PopupListActiveNotations ? NotationListResult :
  T extends PopupUpdateActiveNotation ? NotationListResult :
  T extends PopupRemoveActiveNotation ? NotationListResult :
  T extends PopupListRecordingNotations ? NotationListResult :
  T extends PopupGetStorageUsage
    ? { ok: true; usage: import('../background/storageDurability').StorageUsage } | { ok: false; error: string } :
  T extends PopupListPendingLocalDeliveries
    ? { ok: true; recordings: { id: string; name: string }[] } | { ok: false; error: string } :
  T extends PopupDeliverLocalRecording ? { ok: true } | { ok: false; error: string } :
  T extends PopupFileRecordingToDestination ? { ok: true } | { ok: false; error: string } :
  T extends PopupGetPlaybackManifest ?
    { ok: true; manifest: import('./playback').PlaybackManifest } | { ok: false; error: string } :
  T extends PopupPreparePlaybackSource ? { ok: true; url: string } | { ok: false; error: string } :
  T extends PopupRefreshPlaybackSource ? { ok: true; url: string } | { ok: false; error: string } :
  T extends PopupListRecordingNotationSummaries ?
    { ok: true; summaries: Record<string, RecordingNotationSummary> } | { ok: false; error: string } :
  T extends PopupAddRecordingNotation ? NotationResult :
  T extends PopupUpdateRecordingNotation ? NotationListResult :
  T extends PopupRemoveRecordingNotation ? NotationListResult :
  never;

export type PopupGetTranscript = { type: 'GET_TRANSCRIPT' };
export type PopupResetTranscript = { type: 'RESET_TRANSCRIPT' };
/** Asks the content script whether the Meet captions region is currently present. */
export type PopupGetCaptionState = { type: 'GET_CAPTION_STATE' };

export type PopupToContent =
  | PopupGetTranscript
  | PopupResetTranscript
  | PopupGetCaptionState;

export type PopupToContentResponse<T extends PopupToContent> =
  T extends PopupGetTranscript ? { transcript: string; provider: MeetingProviderInfo } :
  T extends PopupResetTranscript ? { ok: true } :
  T extends PopupGetCaptionState ? { captionsActive: boolean } :
  never;

export type ContentMeetingEnded = {
  type: 'MEETING_ENDED';
  meetingId: string | null;
  reason?: string;
};

export type BgToPopup =
  | { type: 'RECORDING_STATE'; session: RecordingStatusView }
  | { type: 'RECORDING_AWAITING_DELIVERY'; historyId: string }
  | { type: 'RECORDING_SAVED'; filename?: string }
  | { type: 'RECORDING_SAVE_ERROR'; filename?: string; error: string };

/**
 * Typed phase update emitted by the offscreen document and applied to the
 * background-owned session. Both ends are our own code, so the receiver trusts
 * this shape instead of re-normalizing arbitrary input.
 */
export type OffscreenPhaseUpdate = {
  phase: RecordingPhase;
  /**
   * Run epoch echoed back from the offscreen's OFFSCREEN_START. The background
   * fences stale status by dropping any update whose epoch ≠ the current run's;
   * see ADR-0003. Optional so a pre-epoch offscreen reads as "no epoch" (dropped
   * during an active run) rather than a type error.
   */
  epoch?: number;
  uploadSummary?: UploadSummary;
  error?: string;
  warnings?: string[];
  tabResolution?: CapturedTabResolution;
  capturedDevices?: RecordingCaptureDevices;
  /** Bounded anonymous producer snapshot carried only to the background coordinator. */
  telemetrySnapshot?: import('./telemetry').TelemetrySnapshot;
};

export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      meetingSlug: string;
      runConfig: RecordingRunConfig;
      recorderSettings: RecorderRuntimeSettingsSnapshot;
      perfSettings: PerfSettings;
      historyId: string;
      /** Random telemetry-only identity, never derived from history, meeting, or upload identifiers. */
      telemetryRunId: string;
      /** Monotonic run epoch the offscreen must echo in OFFSCREEN_STATE; see ADR-0003. */
      epoch: number;
    }>
  | RpcRequest<{
      type: 'OFFSCREEN_STOP';
      /**
       * The run's notes, already rendered to WebVTT by the background (which
       * owns them) for the offscreen to deliver ahead of the media (ADR-0005).
       * Absent when the recording has no notes.
       */
      notesSidecar?: { vtt: string };
    }>
  | RpcRequest<{ type: 'OFFSCREEN_DISCARD' }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_MIC_MUTED'; muted: boolean }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_CAMERA_MUTED'; muted: boolean }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_INPUT_DEVICE'; device: RecordingInputDevice; deviceId: string }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_PAUSED'; paused: boolean }>
  | RpcRequest<{ type: 'OFFSCREEN_RETRY_UPLOAD'; jobId: string }>
  /**
   * Re-opens retained library bytes as an object URL. The worker cannot make
   * one — `URL.createObjectURL` is not available to a service worker — so a
   * delivery deferred past the offscreen document's lifetime asks for a fresh
   * URL here rather than holding a stale one.
   */
  | RpcRequest<{ type: 'OFFSCREEN_OPEN_RETAINED'; key: string }>
  | RpcRequest<{ type: 'OFFSCREEN_CANCEL_UPLOAD'; jobId: string }>
  | RpcRequest<{
      type: 'OFFSCREEN_RENAME_DRIVE_RESOURCES';
      resources: Array<{ id: string; name: string }>;
    }>;

export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string; opfsFilename?: string }
  /** Background persisted a terminal upload outcome and history state. */
  | { type: 'OFFSCREEN_ACK_UPLOAD_STATE'; jobId: string };

export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_CONNECT' };

export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY'; version?: string }
  | ({ type: 'OFFSCREEN_STATE' } & OffscreenPhaseUpdate)
  | { type: 'OFFSCREEN_UPLOAD_STATE'; job: UploadJob; telemetryRunId?: string; telemetrySnapshot?: import('./telemetry').TelemetrySnapshot }
  | { type: 'OFFSCREEN_SAVE'; historyId: string; stream: import('./recording').RecordingStream; kind?: 'notes'; filename: string; startOffsetMs?: number; blobUrl: string; opfsFilename?: string; retainedKey?: string; deferDelivery?: boolean }
  | { type: 'TELEMETRY_SNAPSHOT'; snapshot: import('./telemetry').TelemetrySnapshot; critical?: boolean }
  | { type: 'TELEMETRY_FLUSH'; snapshot: import('./telemetry').TelemetrySnapshot; reason: 'incident' | 'recording_complete' | 'upload_complete' };

export type TelemetryRunMessage = { type: 'TELEMETRY_RUN'; runId: string | null; enabled: boolean };

export type PerfEventMessage = {
  type: 'PERF_EVENT';
  entry: {
    source: string;
    scope: string;
    event: string;
    ts: number;
    fields: Record<string, string | number | boolean | null>;
  };
};

export type E2EDriveFetchMessage = {
  type: 'E2E_DRIVE_FETCH';
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** Checks whether a runtime message belongs to the popup -> background command set. */
export function isPopupToBgMessage(value: unknown): value is PopupToBg {
  return hasKnownMessageType(value, POPUP_TO_BG_MESSAGE_TYPES);
}

/** Checks whether a tab message belongs to the popup -> content command set. */
export function isPopupToContentMessage(value: unknown): value is PopupToContent {
  return hasKnownMessageType(value, POPUP_TO_CONTENT_MESSAGE_TYPES);
}

/** Checks whether a content script message reports that the active meeting ended. */
export function isMeetingEndedMessage(value: unknown): value is ContentMeetingEnded {
  return hasKnownMessageType(value, CONTENT_TO_BG_MESSAGE_TYPES);
}

/** Checks whether a port/runtime message belongs to the offscreen -> background set. */
export function isOffscreenToBgMessage(value: unknown): value is OffscreenToBg {
  return hasKnownMessageType(value, OFFSCREEN_TO_BG_MESSAGE_TYPES);
}

/** Checks whether a runtime nudge is asking the offscreen page to reconnect its port. */
export function isBgToOffscreenRuntimeMessage(value: unknown): value is BgToOffscreenRuntime {
  return getMessageType(value) === BG_TO_OFFSCREEN_RUNTIME_CONNECT;
}

/** Checks whether a message is a structured performance event emitted by another context. */
export function isPerfEventMessage(value: unknown): value is PerfEventMessage {
  return getMessageType(value) === PERF_EVENT_MESSAGE_TYPE;
}

export function isE2EDriveFetchMessage(value: unknown): value is E2EDriveFetchMessage {
  return getMessageType(value) === 'E2E_DRIVE_FETCH';
}

/** Creates a lightweight random request id for port-based RPC messages. */
export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
