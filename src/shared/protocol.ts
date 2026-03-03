// --------------------
// Shared message types
// --------------------

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };
export type RpcResponse = { __respFor: RpcId; payload: any };

export type BgToOffscreenRpc =
  | RpcRequest<{ type: 'OFFSCREEN_START'; streamId: string }>
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>
  | RpcRequest<{ type: 'OFFSCREEN_STATUS' }>;

export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string };

export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY' }
  | { type: 'RECORDING_STATE'; recording: boolean; warning?: string }
  | { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string };

export type PopupToBg =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_RECORDING_STATUS' };

export type BgToPopup =
  | { type: 'RECORDING_STATE'; recording: boolean }
  | { type: 'RECORDING_SAVED'; filename?: string };

// Non-port, runtime.sendMessage helpers (used during startup)
export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_PING' }
  | { type: 'OFFSCREEN_CONNECT' };

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
