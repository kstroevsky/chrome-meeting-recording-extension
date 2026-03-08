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

export async function sendToBackground<T extends PopupToBg>(
  message: T
): Promise<PopupToBgResponse<T>> {
  return await sendRuntimeMessage<PopupToBgResponse<T>>(message);
}

export async function sendToContent<T extends PopupToContent>(
  tabId: number,
  message: T
): Promise<PopupToContentResponse<T>> {
  return await sendTabMessage<PopupToContentResponse<T>>(tabId, message);
}

export async function broadcastToPopup(message: BgToPopup): Promise<void> {
  try {
    await sendRuntimeMessage(message);
  } catch {}
}
