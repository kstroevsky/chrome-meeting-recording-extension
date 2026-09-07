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

/**
 * Raised when Chrome resolves runtime.sendMessage without a response. For an
 * unpacked extension this normally means a rebuilt popup is talking to an older,
 * still-running MV3 service worker that does not recognize the new command.
 */
export class BackgroundNoResponseError extends Error {
  constructor(type: string) {
    super(
      `The background runtime did not respond to ${type}. Reload the unpacked extension in `
      + 'chrome://extensions so its service worker matches this popup. The recording is still active; nothing was discarded.'
    );
    this.name = 'BackgroundNoResponseError';
  }
}

/** Sends a typed command from popup/offscreen code to the background worker. */
export async function sendToBackground<T extends PopupToBg>(
  message: T
): Promise<PopupToBgResponse<T>> {
  const response = await sendRuntimeMessage<PopupToBgResponse<T> | undefined>(message);
  if (response == null) throw new BackgroundNoResponseError(message.type);
  return response;
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
export async function broadcastToPopup(message: BgToPopup): Promise<boolean> {
  try {
    await sendRuntimeMessage(message);
    return true;
  } catch {
    // No receiver: every popup is closed. Callers that only inform can ignore
    // this; one that is asking a question needs to know nobody was asked.
    return false;
  }
}
