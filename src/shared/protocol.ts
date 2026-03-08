/**
 * @file shared/protocol.ts
 *
 * Single source of truth for ALL inter-context messages in this extension.
 */

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };
export type RpcResponse<T = unknown> = { __respFor: RpcId; payload: T };

export type RecordingPhase = 'idle' | 'recording' | 'uploading';
export type RecordingStream = 'tab' | 'mic' | 'selfVideo';

export type UploadSummaryEntry = {
  stream: RecordingStream;
  filename: string;
  error?: string;
};

export type UploadSummary = {
  uploaded: UploadSummaryEntry[];
  localFallbacks: UploadSummaryEntry[];
};

export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      storageMode?: 'local' | 'drive';
      recordSelfVideo?: boolean;
      selfVideoQuality?: 'standard' | 'high';
    }>
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>
  | RpcRequest<{ type: 'OFFSCREEN_STATUS' }>;

export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string; opfsFilename?: string };

export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY' }
  | {
      type: 'RECORDING_STATE';
      phase: RecordingPhase;
      uploadSummary?: UploadSummary;
    }
  | { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string };

export type PopupToBg =
  | {
      type: 'START_RECORDING';
      tabId: number;
      storageMode?: 'local' | 'drive';
      recordSelfVideo?: boolean;
      selfVideoQuality?: 'standard' | 'high';
    }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_RECORDING_STATUS' }
  | { type: 'GET_DRIVE_TOKEN' };

export type BgToPopup =
  | {
      type: 'RECORDING_STATE';
      phase: RecordingPhase;
      uploadSummary?: UploadSummary;
    }
  | { type: 'RECORDING_SAVED'; filename?: string }
  | { type: 'RECORDING_SAVE_ERROR'; filename?: string; error: string };

export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_PING' }
  | { type: 'OFFSCREEN_CONNECT' };

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
