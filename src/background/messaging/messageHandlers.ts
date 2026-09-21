/**
 * Registers the MV3 runtime message listener synchronously at composition time.
 * Feature routing lives behind the listener so registration itself stays eager.
 */
import { createMessageListener } from './MessageRouter';
import type { MessageHandlersDeps } from './types';

export type { MessageHandlersDeps } from './types';

export function registerMessageHandlers(deps: MessageHandlersDeps): void {
  chrome.runtime.onMessage.addListener(createMessageListener(deps));
}
