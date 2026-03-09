/**
 * @file shared/protocol.ts
 *
 * Single source of truth for all inter-context message contracts in the
 * extension.
 */

import type { MeetingProviderInfo } from './provider';
import type {
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingPhase,
  UploadSummary,
} from './recording';
import {
  BG_TO_OFFSCREEN_RUNTIME_CONNECT,
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
  | { ok: true; session: RecordingSessionSnapshot }
  | { ok: false; error: string; session: RecordingSessionSnapshot };

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

export type PopupToBg =
  | PopupStartRecording
  | PopupStopRecording
  | PopupGetRecordingStatus
  | PopupGetDriveToken;

export type PopupToBgResponse<T extends PopupToBg> =
  T extends PopupStartRecording ? CommandResult :
  T extends PopupStopRecording ? CommandResult :
  T extends PopupGetRecordingStatus ? { session: RecordingSessionSnapshot } :
  T extends PopupGetDriveToken ? DriveTokenResponse :
  never;

export type PopupGetTranscript = { type: 'GET_TRANSCRIPT' };
export type PopupResetTranscript = { type: 'RESET_TRANSCRIPT' };
export type PopupGetProviderInfo = { type: 'GET_PROVIDER_INFO' };

export type PopupToContent =
  | PopupGetTranscript
  | PopupResetTranscript
  | PopupGetProviderInfo;

export type PopupToContentResponse<T extends PopupToContent> =
  T extends PopupGetTranscript ? { transcript: string; provider: MeetingProviderInfo } :
  T extends PopupResetTranscript ? { ok: true } :
  T extends PopupGetProviderInfo ? MeetingProviderInfo :
  never;

export type BgToPopup =
  | { type: 'RECORDING_STATE'; session: RecordingSessionSnapshot }
  | { type: 'RECORDING_SAVED'; filename?: string }
  | { type: 'RECORDING_SAVE_ERROR'; filename?: string; error: string };

export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      runConfig: RecordingRunConfig;
    }>
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>;

export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string; opfsFilename?: string };

export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_CONNECT' };

export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY' }
  | {
      type: 'OFFSCREEN_STATE';
      phase: RecordingPhase;
      uploadSummary?: UploadSummary;
      error?: string;
    }
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

/** Checks whether a runtime message belongs to the popup -> background command set. */
export function isPopupToBgMessage(value: unknown): value is PopupToBg {
  return hasKnownMessageType(value, POPUP_TO_BG_MESSAGE_TYPES);
}

/** Checks whether a tab message belongs to the popup -> content command set. */
export function isPopupToContentMessage(value: unknown): value is PopupToContent {
  return hasKnownMessageType(value, POPUP_TO_CONTENT_MESSAGE_TYPES);
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

/** Creates a lightweight random request id for port-based RPC messages. */
export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
