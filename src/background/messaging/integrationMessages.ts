import type { PopupToBg } from '../../shared/protocol';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

export async function handleIntegrationMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  const integrations = deps.integrations;
  if (!integrations) throw new Error('Integrations are unavailable');
  switch (msg.type) {
    case 'PREVIEW_INTEGRATION_PAYLOAD':
      sendResponse({ ok: true, preview: await integrations.preview(msg.recordingId, msg.policy) });
      return true;
    case 'LIST_INTEGRATIONS':
      sendResponse({ ok: true, destinations: await integrations.listDestinations() });
      return true;
    case 'CREATE_INTEGRATION':
      sendResponse({ ok: true, created: await integrations.createDestination(msg.input) });
      return true;
    case 'TEST_INTEGRATION':
      sendResponse({ ok: true, result: await integrations.testDestination(msg.destinationId) });
      return true;
    case 'SEND_RECORDING_TO_INTEGRATION':
      sendResponse({
        ok: true,
        delivery: await integrations.sendRecording(msg.destinationId, msg.recordingId),
      });
      return true;
    case 'LIST_INTEGRATION_DELIVERIES':
      sendResponse({ ok: true, deliveries: await integrations.listDeliveries() });
      return true;
    default:
      return false;
  }
}
