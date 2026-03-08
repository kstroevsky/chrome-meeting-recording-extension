/**
 * @file shared/protocol.ts
 *
 * Single source of truth for ALL inter-context messages in this extension.
 *
 * Chrome extensions are multi-process: Popup, Background (SW), Offscreen, and
 * Content Script each run in their own JavaScript context and communicate only
 * through message passing. Defining every message as a discriminated union here
 * means TypeScript will catch typos, missing fields, and unhandled cases at
 * compile time rather than at runtime.
 *
 * Naming convention:
 *   <Sender>To<Receiver>  — e.g. PopupToBg, BgToOffscreenRpc
 *   "Rpc" suffix        — messages that expect a response (have __id)
 *   "OneWay" suffix     — fire-and-forget messages (no __id, no response)
 *   "Runtime" suffix    — messages sent via chrome.runtime.sendMessage
 *                          (as opposed to a Port)
 *
 * Transport:
 *   Popup ↔ Background:    chrome.runtime.sendMessage / sendResponse
 *   Background ↔ Offscreen: chrome.runtime.Port named 'offscreen'
 *                            (see shared/rpc.ts for the RPC layer on top)
 *   Background → Popup:     chrome.runtime.sendMessage (broadcast, popup may be closed)
 *   Popup ↔ Content Script: chrome.tabs.sendMessage / sendResponse
 */

export type RpcId = string;

export type RpcRequest<T extends { type: string }> = T & { __id?: RpcId };

/**
 * Generic so that the client-side resolve() can be typed as `TRes` rather than
 * `any`. The server always produces `payload: unknown` at the transport layer —
 * the generic is only meaningful on the receiving (client) end.
 *
 * Default is `unknown` (not `any`) so that callers must explicitly handle the
 * type rather than silently acting on an unchecked value.
 */
export type RpcResponse<T = unknown> = { __respFor: RpcId; payload: T };

/**
 * Background → Offscreen via Port (RPC — expects a response).
 * Background calls these when the popup requests a recording action.
 * Each message gets a `__id` added by createPortRpcClient() before sending.
 */
export type BgToOffscreenRpc =
  | RpcRequest<{
      type: 'OFFSCREEN_START';
      streamId: string;
      storageMode?: 'local' | 'drive';
      recordSelfVideo?: boolean;
      selfVideoQuality?: 'standard' | 'high';
    }> // Begin capturing + recording
  | RpcRequest<{ type: 'OFFSCREEN_STOP' }>                   // Finalize and save the recording
  | RpcRequest<{ type: 'OFFSCREEN_STATUS' }>;                // Query whether recording is active

/**
 * Background → Offscreen via Port (one-way — no response expected).
 * Sent after the download API has been given the blob URL, so the offscreen
 * can safely call URL.revokeObjectURL() without a race condition.
 */
export type BgToOffscreenOneWay =
  | { type: 'REVOKE_BLOB_URL'; blobUrl: string; opfsFilename?: string };

/**
 * Offscreen → Background via Port (one-way events).
 * The offscreen pushes these voluntarily; background reacts by updating badge,
 * forwarding to open popups, or triggering downloads.
 */
export type OffscreenToBg =
  | { type: 'OFFSCREEN_READY' }                                         // Script loaded, Port connected
  | { type: 'RECORDING_STATE'; recording: boolean; warning?: string }  // State changed (start/stop/error)
  | { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string };      // Recording ready to download

/**
 * Popup → Background via runtime.sendMessage.
 * Background responds synchronously via sendResponse with { ok: boolean; error?: string }.
 * `tabId` in START_RECORDING is required because only Background can call
 * tabCapture.getMediaStreamId (not the popup itself).
 */
export type PopupToBg =
  | {
      type: 'START_RECORDING';
      tabId: number;
      storageMode?: 'local' | 'drive';
      recordSelfVideo?: boolean;
      selfVideoQuality?: 'standard' | 'high';
    } // User pressed Record; tabId identifies the Meet tab
  | { type: 'STOP_RECORDING' }                 // User pressed Stop
  | { type: 'GET_RECORDING_STATUS' }          // Popup opened; check if already recording
  | { type: 'GET_DRIVE_TOKEN' };               // Get token internally

/**
 * Background → Popup via runtime.sendMessage (broadcast — popup may be closed).
 * Background sends these after state changes; popup ignores them if not open.
 */
export type BgToPopup =
  | { type: 'RECORDING_STATE'; recording: boolean }  // Forwarded from offscreen; popup updates UI
  | { type: 'RECORDING_SAVED'; filename?: string };   // Download triggered; popup can show a toast

/**
 * Background → Offscreen via runtime.sendMessage (NOT a Port).
 * Used only during the startup handshake, before the Port is established.
 * See offscreen.ts for full explanation of why these exist alongside the Port.
 */
export type BgToOffscreenRuntime =
  | { type: 'OFFSCREEN_PING' }    // "Are you loaded?" — offscreen replies { ok: true }
  | { type: 'OFFSCREEN_CONNECT' }; // "Please re-connect your Port" — used after a crash

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}
