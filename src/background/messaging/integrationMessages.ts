import type { PopupToBg } from '../../shared/protocol';
import { IntegrationPayloadTooLargeError } from '../../integrations/payload';
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
    case 'LIST_INTEGRATION_RECORDINGS':
      sendResponse({ ok: true, recordings: await integrations.listRecordings() });
      return true;
    case 'LIST_INTEGRATIONS':
      sendResponse({ ok: true, destinations: await integrations.listDestinations() });
      return true;
    case 'CREATE_INTEGRATION':
      sendResponse({ ok: true, created: await integrations.createDestination(msg.input) });
      return true;
    case 'DELETE_INTEGRATION':
      sendResponse({ ok: true, ...(await integrations.deleteDestination(msg.destinationId)) });
      return true;
    case 'TEST_INTEGRATION':
      sendResponse({ ok: true, result: await integrations.testDestination(msg.destinationId) });
      return true;
    case 'SEND_RECORDING_TO_INTEGRATION':
      try {
        sendResponse({
          ok: true,
          delivery: await integrations.sendRecording(msg.destinationId, msg.recordingId),
        });
      } catch (error) {
        if (!(error instanceof IntegrationPayloadTooLargeError)) throw error;
        sendResponse({
          ok: false,
          error: error.message,
          payloadTooLarge: {
            totalBytes: error.measurement.totalBytes,
            transcriptBytes: error.measurement.transcriptBytes,
            maxBytes: error.maxBytes,
          },
        });
      }
      return true;
    case 'LIST_INTEGRATION_DELIVERIES':
      sendResponse({ ok: true, deliveries: await integrations.listDeliveries() });
      return true;
    default:
      return false;
  }
}
