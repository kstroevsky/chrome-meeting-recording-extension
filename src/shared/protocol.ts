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

const POPUP_TO_BG_TYPES = ['START_RECORDING', 'STOP_RECORDING', 'GET_RECORDING_STATUS', 'GET_DRIVE_TOKEN'] as const;
const POPUP_TO_CONTENT_TYPES = ['GET_TRANSCRIPT', 'RESET_TRANSCRIPT', 'GET_PROVIDER_INFO'] as const;
const OFFSCREEN_TO_BG_TYPES = ['OFFSCREEN_READY', 'OFFSCREEN_STATE', 'OFFSCREEN_SAVE'] as const;

function getType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function hasKnownType(value: unknown, allowed: readonly string[]): boolean {
  const type = getType(value);
  return type != null && allowed.includes(type);
}

export function isPopupToBgMessage(value: unknown): value is PopupToBg {
  return hasKnownType(value, POPUP_TO_BG_TYPES);
}

export function isPopupToContentMessage(value: unknown): value is PopupToContent {
  return hasKnownType(value, POPUP_TO_CONTENT_TYPES);
}

export function isOffscreenToBgMessage(value: unknown): value is OffscreenToBg {
  return hasKnownType(value, OFFSCREEN_TO_BG_TYPES);
}

export function isBgToOffscreenRuntimeMessage(value: unknown): value is BgToOffscreenRuntime {
  return getType(value) === 'OFFSCREEN_CONNECT';
}

export function isPerfEventMessage(value: unknown): value is PerfEventMessage {
  return getType(value) === 'PERF_EVENT';
}

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
