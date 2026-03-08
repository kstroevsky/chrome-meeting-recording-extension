/**
 * @file shared/protocolMessageTypes.ts
 *
 * Message type lists used by protocol guards for runtime validation.
 */

export const POPUP_TO_BG_MESSAGE_TYPES = [
  'START_RECORDING',
  'STOP_RECORDING',
  'GET_RECORDING_STATUS',
  'GET_DRIVE_TOKEN',
] as const;

export const POPUP_TO_CONTENT_MESSAGE_TYPES = [
  'GET_TRANSCRIPT',
  'RESET_TRANSCRIPT',
  'GET_PROVIDER_INFO',
] as const;

export const OFFSCREEN_TO_BG_MESSAGE_TYPES = [
  'OFFSCREEN_READY',
  'OFFSCREEN_STATE',
  'OFFSCREEN_SAVE',
] as const;

export const BG_TO_OFFSCREEN_RUNTIME_CONNECT = 'OFFSCREEN_CONNECT' as const;
export const PERF_EVENT_MESSAGE_TYPE = 'PERF_EVENT' as const;
