/**
 * @file shared/messages.ts
 *
 * Thin typed wrappers around extension runtime and tab messaging.
 */

import type {
  BgToPopup,
  PopupToBg,
  PopupToBgResponse,
  PopupToContent,
  PopupToContentResponse,
} from './protocol';
import { sendRuntimeMessage } from '../platform/chrome/runtime';
import { sendTabMessage } from '../platform/chrome/tabs';

/** Sends a typed command from popup/offscreen code to the background worker. */
export async function sendToBackground<T extends PopupToBg>(
  message: T
): Promise<PopupToBgResponse<T>> {
  return await sendRuntimeMessage<PopupToBgResponse<T>>(message);
}

/** Sends a typed command from popup code to the active content script. */
export async function sendToContent<T extends PopupToContent>(
  tabId: number,
  message: T
): Promise<PopupToContentResponse<T>> {
  return await sendTabMessage<PopupToContentResponse<T>>(tabId, message);
}

/**
 * Best-effort broadcast to the popup if it is currently open.
 * Errors are intentionally swallowed — Chrome throws "Receiving end does not
 * exist" whenever the popup is closed, which is the common case.
 */
export async function broadcastToPopup(message: BgToPopup): Promise<void> {
  try {
    await sendRuntimeMessage(message);
  } catch {}
}
