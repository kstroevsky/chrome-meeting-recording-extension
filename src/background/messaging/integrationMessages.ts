import type { PopupToBg } from '../../shared/protocol';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

export async function handleIntegrationMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  if (msg.type !== 'PREVIEW_INTEGRATION_PAYLOAD') return false;
  if (!deps.integrationPreview) throw new Error('Integration preview is unavailable');
  const preview = await deps.integrationPreview.preview(msg.recordingId, msg.policy);
  sendResponse({ ok: true, preview });
  return true;
}
