/**
 * @file shared/protocol.ts
 *
 * Single source of truth for all inter-context message contracts in the
 * extension.
 */

import type { MeetingProviderInfo } from './provider';
import type { RecorderRuntimeSettingsSnapshot } from './settings';
import type { PerfSettings } from './perf';
import type {
  RecordingRunConfig,
  RecordingStatusView,
  RecordingPhase,
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

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };
export type RpcResponse<T = unknown> = { __respFor: RpcId; payload: T };

export type CommandResult =
  | { ok: true; session: RecordingStatusView }
  | { ok: false; error: string; session: RecordingStatusView };

export type DriveTokenResponse =
  | { ok: true; token: string }
  | { ok: false; error: string };

export type PopupStartRecording = {
  type: 'START_RECORDING';
  tabId: number;
  runConfig: RecordingRunConfig;
};

export type PopupStopRecording = { type: 'STOP_RECORDING' };
export type PopupGetRecordingStatus = { type: 'GET_RECORDING_STATUS' };
export type PopupGetDriveToken = { type: 'GET_DRIVE_TOKEN'; refresh?: boolean };
/** Toggles microphone mute on the live recording; the mic emits silence while muted. */
export type PopupSetMicMuted = { type: 'SET_MIC_MUTED'; muted: boolean };
/** Toggles the camera on the live self-video recording; it emits black frames while hidden. */
export type PopupSetCameraMuted = { type: 'SET_CAMERA_MUTED'; muted: boolean };
/** Pauses/resumes the whole recording; the paused span is absent from the files (seamless join). */
export type PopupSetPaused = { type: 'SET_PAUSED'; paused: boolean };
/** Dismisses a finished background upload job's tab (ADR-0004). */
export type PopupDismissUploadJob = { type: 'DISMISS_UPLOAD_JOB'; jobId: string };

export type PopupToBg =
  | PopupStartRecording
  | PopupStopRecording
  | PopupGetRecordingStatus
  | PopupGetDriveToken
  | PopupSetMicMuted
  | PopupSetCameraMuted
  | PopupSetPaused
  | PopupDismissUploadJob;

export type PopupToBgResponse<T extends PopupToBg> =
  T extends PopupStartRecording ? CommandResult :
  T extends PopupStopRecording ? CommandResult :
  T extends PopupGetRecordingStatus ? { session: RecordingStatusView } :
  T extends PopupGetDriveToken ? DriveTokenResponse :
  T extends PopupSetMicMuted ? CommandResult :
  T extends PopupSetCameraMuted ? CommandResult :
  T extends PopupSetPaused ? CommandResult :
  T extends PopupDismissUploadJob ? { session: RecordingStatusView } :
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
  /**
   * Live Drive-upload progress as a fraction in [0, 1], emitted only while
   * `phase === 'uploading'`. Throttled to whole-percent steps by the finalizer so
   * a many-chunk upload re-broadcasts at most ~100 times. Absent in every other
   * phase (and during the brief pre-first-chunk window) so the popup falls back to
   * the indeterminate spinner.
   */
  uploadProgress?: number;
};

export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      meetingSlug: string;
      runConfig: RecordingRunConfig;
      recorderSettings: RecorderRuntimeSettingsSnapshot;
      perfSettings: PerfSettings;
      /** Monotonic run epoch the offscreen must echo in OFFSCREEN_STATE; see ADR-0003. */
      epoch: number;
    }>
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_MIC_MUTED'; muted: boolean }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_CAMERA_MUTED'; muted: boolean }>
  | RpcRequest<{ type: 'OFFSCREEN_SET_PAUSED'; paused: boolean }>;

export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string; opfsFilename?: string };

export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_CONNECT' };

export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY'; version?: string }
  | ({ type: 'OFFSCREEN_STATE' } & OffscreenPhaseUpdate)
  | { type: 'OFFSCREEN_UPLOAD_STATE'; job: UploadJob }
  | { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string };

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
