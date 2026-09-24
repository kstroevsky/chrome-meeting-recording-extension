/**
 * @file shared/protocolMessageTypes.ts
 *
 * Message type lists used by protocol guards for runtime validation.
 */

export const POPUP_TO_BG_MESSAGE_TYPES = [
  'START_RECORDING',
  'STOP_RECORDING',
  'DISCARD_RECORDING',
  'GET_RECORDING_STATUS',
  'GET_DRIVE_TOKEN',
  'GET_SHARE_IDENTITY_TOKEN',
  'PUBLISH_SHARE',
  'LIST_SHARES',
  'REVOKE_SHARE',
  'DELETE_SHARE',
  'SET_MIC_MUTED',
  'SET_CAMERA_MUTED',
  'SET_INPUT_DEVICE',
  'SET_PAUSED',
  'DISMISS_UPLOAD_JOB',
  'RETRY_UPLOAD_JOB',
  'CANCEL_UPLOAD_JOB',
  'SKIP_RECORDING_NAMING',
  'DISMISS_INTERRUPTION',
  'LIST_RECORDING_HISTORY',
  'RENAME_RECORDING_HISTORY',
  'SET_RECORDING_HISTORY_NOTE',
  'REMOVE_RECORDING_HISTORY',
  'OPEN_RECORDING_HISTORY_FILE',
  'MARK_NOTATION',
  'END_NOTATION',
  'LIST_ACTIVE_NOTATIONS',
  'UPDATE_ACTIVE_NOTATION',
  'REMOVE_ACTIVE_NOTATION',
  'LIST_RECORDING_NOTATIONS',
  'GET_RECORDING_PLAYBACK_MANIFEST',
  'FILE_RECORDING_TO_DESTINATION',
  'GET_STORAGE_USAGE',
  'RENAME_DRIVE_ROOT_FOLDER',
  'LIST_UNSAVED_RECORDINGS',
  'RESOLVE_UNSAVED_RECORDING',
  'LIST_PENDING_LOCAL_DELIVERIES',
  'DELIVER_LOCAL_RECORDING',
  'PREPARE_RECORDING_PLAYBACK_SOURCE',
  'REFRESH_RECORDING_PLAYBACK_SOURCE',
  'LIST_RECORDING_NOTATION_SUMMARIES',
  'ADD_RECORDING_NOTATION',
  'UPDATE_RECORDING_NOTATION',
  'REMOVE_RECORDING_NOTATION',
  'GET_RECORDING_TRANSCRIPT',
  'LIST_RECORDING_TOPIC_SUMMARIES',
] as const;

/** The subset of popup commands validated by `isRecordingHistoryMessage`. */
export const RECORDING_HISTORY_MESSAGE_TYPES = [
  'LIST_RECORDING_HISTORY',
  'RENAME_RECORDING_HISTORY',
  'SET_RECORDING_HISTORY_NOTE',
  'REMOVE_RECORDING_HISTORY',
  'OPEN_RECORDING_HISTORY_FILE',
] as const;

/** The subset of popup commands validated by `isRecordingNotationMessage`. */
export const RECORDING_NOTATION_MESSAGE_TYPES = [
  'MARK_NOTATION',
  'END_NOTATION',
  'LIST_ACTIVE_NOTATIONS',
  'UPDATE_ACTIVE_NOTATION',
  'REMOVE_ACTIVE_NOTATION',
  'LIST_RECORDING_NOTATIONS',
  'LIST_RECORDING_NOTATION_SUMMARIES',
  'ADD_RECORDING_NOTATION',
  'UPDATE_RECORDING_NOTATION',
  'REMOVE_RECORDING_NOTATION',
] as const;

/** The subset of popup commands validated by `isRecordingTranscriptMessage`. */
export const RECORDING_TRANSCRIPT_MESSAGE_TYPES = [
  'GET_RECORDING_TRANSCRIPT',
] as const;

/**
 * Topic-analysis reads (ADR-0007). Their own list rather than folded into the
 * transcript's: they answer from a different aggregate, and a failure in either
 * must stay a `{ ok: false }` answer instead of a session failure.
 */
export const RECORDING_ANALYSIS_MESSAGE_TYPES = [
  'LIST_RECORDING_TOPIC_SUMMARIES',
] as const;

/** Owner-side publication commands. They never mutate the recording session. */
export const SHARING_MESSAGE_TYPES = [
  'PUBLISH_SHARE',
  'LIST_SHARES',
  'REVOKE_SHARE',
  'DELETE_SHARE',
] as const;

/**
 * Library aggregate commands whose failures answer `{ ok: false, error }`.
 * Recording-session failure policy is deliberately owned by MessageRouter;
 * response shape and whether canonical capture state should fail are separate
 * decisions.
 */
export const NON_SESSION_RESPONSE_MESSAGE_TYPES = [
  ...RECORDING_HISTORY_MESSAGE_TYPES,
  ...RECORDING_NOTATION_MESSAGE_TYPES,
  ...RECORDING_TRANSCRIPT_MESSAGE_TYPES,
  ...RECORDING_ANALYSIS_MESSAGE_TYPES,
  ...SHARING_MESSAGE_TYPES,
] as const;

/**
 * Extension -> content script. Named for its original sender; background also
 * uses this channel (`RESET_TRANSCRIPT`, and the transcript-capture pair below).
 */
export const POPUP_TO_CONTENT_MESSAGE_TYPES = [
  'GET_TRANSCRIPT',
  'RESET_TRANSCRIPT',
  'GET_CAPTION_STATE',
  'SET_TRANSCRIPT_CAPTURE',
  'GET_TRANSCRIPT_UTTERANCES',
] as const;

export const CONTENT_TO_BG_MESSAGE_TYPES = [
  'MEETING_ENDED',
  'TRANSCRIPT_UTTERANCES',
  'GET_TRANSCRIPT_CAPTURE_STATE',
] as const;

export const OFFSCREEN_TO_BG_MESSAGE_TYPES = [
  'OFFSCREEN_READY',
  'OFFSCREEN_STATE',
  'OFFSCREEN_UPLOAD_STATE',
  'OFFSCREEN_ANALYSIS_STATE',
  'OFFSCREEN_ANALYSIS_RESULT',
  'OFFSCREEN_SAVE',
  'TELEMETRY_SNAPSHOT',
  'TELEMETRY_FLUSH',
] as const;

export const BG_TO_OFFSCREEN_RUNTIME_CONNECT = 'OFFSCREEN_CONNECT' as const;
export const PERF_EVENT_MESSAGE_TYPE = 'PERF_EVENT' as const;
export const TELEMETRY_RUN_MESSAGE_TYPE = 'TELEMETRY_RUN' as const;
