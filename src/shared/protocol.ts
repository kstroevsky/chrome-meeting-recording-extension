/**
 * @file shared/protocol.ts
 *
 * Single source of truth for ALL inter-context messages in this extension.
 *
 * Chrome extensions are multi-process: popup, background service worker,
 * offscreen document, and content script all run in separate contexts and only
 * communicate through message passing. Keeping the transport contracts here
 * lets the compiler catch drift when the recording lifecycle changes.
 *
 * Transport summary:
 *   Popup ↔ Background:     chrome.runtime.sendMessage / sendResponse
 *   Background ↔ Offscreen: chrome.runtime.Port named 'offscreen'
 *   Background → Popup:     chrome.runtime.sendMessage (broadcast; popup may be closed)
 *
 * Current recording lifecycle:
 *   idle -> recording -> uploading -> idle
 *
 * Important behavioral note:
 *   In Drive mode, upload happens only after capture has stopped. The popup is
 *   therefore a pure observer of state and can be closed safely while upload
 *   continues in background/offscreen contexts.
 */

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };
export type RpcResponse<T = unknown> = { __respFor: RpcId; payload: T };

export type RecordingPhase = 'idle' | 'recording' | 'uploading';
export type RecordingStream = 'tab' | 'mic' | 'selfVideo';
export type RecordingRunConfig = {
  storageMode: 'local' | 'drive';
  recordSelfVideo: boolean;
  selfVideoQuality: 'standard' | 'high';
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

export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      storageMode?: 'local' | 'drive';
      recordSelfVideo?: boolean;
      selfVideoQuality?: 'standard' | 'high';
    }>
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>;

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
  | { type: 'GET_DRIVE_TOKEN'; refresh?: boolean };

export type BgToPopup =
  | {
      type: 'RECORDING_STATE';
      phase: RecordingPhase;
      uploadSummary?: UploadSummary;
      runConfig?: RecordingRunConfig;
    }
  | { type: 'RECORDING_SAVED'; filename?: string }
  | { type: 'RECORDING_SAVE_ERROR'; filename?: string; error: string };

export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_CONNECT' };

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
