import type { PopupToBg } from '../../shared/protocol';
import { fetchShareIdentityTokenWithFallback } from '../sharing/shareIdentityAuth';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

/** Identity acquisition stays in the background where interactive Chrome auth is allowed. */
export function handleShareIdentityTokenMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): boolean | undefined {
  if (msg.type !== 'GET_SHARE_IDENTITY_TOKEN') return undefined;
  fetchShareIdentityTokenWithFallback({ refresh: msg.refresh === true })
    .then((result) => {
      if (!result.ok) deps.L.warn('GET_SHARE_IDENTITY_TOKEN failed:', result.error);
      sendResponse(result);
    })
    .catch((error: any) => {
      const message = error?.message || String(error);
      deps.L.error('GET_SHARE_IDENTITY_TOKEN unexpected failure:', message);
      sendResponse({ ok: false, error: message });
    });
  return true;
}
