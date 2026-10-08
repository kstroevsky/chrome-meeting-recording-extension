import type { PopupToBg } from '../../shared/protocol';
import { IntegrationPayloadTooLargeError } from '../../integrations/payload';
import { pendingLocalDeliveries } from '../../shared/recordingHistory';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

function requireDestinations(deps: MessageHandlersDeps) {
  if (!deps.destinations) throw new Error('Recording destinations are unavailable');
  return deps.destinations;
}

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
    case 'CREATE_INTEGRATION': {
      const created = await integrations.createDestination(msg.input);
      // The new integration is offered in "Save to" straight away (plan E4). The two
      // live in different stores, so a failure here leaves the integration in place
      // and the settings page offers to add the destination by hand.
      const profile = await deps.destinations?.save({ destinationId: created.destination.id })
        .catch((error) => { deps.L.warn('Could not add the integration to Save to:', error); return undefined; });
      sendResponse({ ok: true, created, ...(profile ? { profile } : {}) });
      return true;
    }
    case 'DELETE_INTEGRATION':
      sendResponse({ ok: true, ...(await integrations.deleteDestination(msg.destinationId)) });
      return true;
    case 'TEST_INTEGRATION':
      sendResponse({ ok: true, result: await integrations.testDestination(msg.destinationId) });
      return true;
    case 'CONFIGURE_INTEGRATION_MEDIA':
      await integrations.configureMedia(msg.destinationId, msg.bearer);
      sendResponse({ ok: true });
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
    case 'RETRY_INTEGRATION_DELIVERY':
      sendResponse({ ok: true, delivery: await integrations.retryDelivery(msg.deliveryId) });
      return true;
    case 'LIST_RECORDING_DESTINATIONS':
      sendResponse({ ok: true, ...(await requireDestinations(deps).list()) });
      return true;
    case 'SAVE_RECORDING_DESTINATION':
      sendResponse({ ok: true, profile: await requireDestinations(deps).save(msg.input) });
      return true;
    case 'REMOVE_RECORDING_DESTINATION':
      sendResponse({ ok: true, removed: await requireDestinations(deps).remove(msg.profileId) });
      return true;
    case 'LIST_HELD_RECORDING_ROUTES':
      sendResponse({ ok: true, recordings: await listHeldRecordings(deps) });
      return true;
    case 'GET_RECORDING_ROUTES':
    case 'CONFIRM_RECORDING_ROUTES':
    case 'RETRY_RECORDING_ROUTING': {
      const recordingId = msg.recordingId ?? deps.session.getSnapshot().historyId;
      if (!recordingId) {
        sendResponse({ ok: true, routes: [] });
        return true;
      }
      const expected = await deps.destinations?.routesForRecording(recordingId) ?? [];
      if (msg.type === 'CONFIRM_RECORDING_ROUTES') {
        await integrations.confirmRecordingRoutes(recordingId, msg.removedDestinationIds);
      } else if (msg.type === 'RETRY_RECORDING_ROUTING' && expected.length) {
        await integrations.beginRecordingRouting(recordingId, expected);
      }
      sendResponse({ ok: true, recordingId, routes: await integrations.recordingRoutes(recordingId, expected) });
      return true;
    }
    default:
      return false;
  }
}

/**
 * Finished recordings still waiting for the routes they started with to be
 * confirmed. The run in progress, a recording still saving or not fully saved,
 * and one whose files still wait for the end dialog are left out.
 */
async function listHeldRecordings(deps: MessageHandlersDeps) {
  const integrations = deps.integrations!;
  const snapshot = deps.session.getSnapshot();
  const running = snapshot.phase === 'idle' || snapshot.phase === 'failed' ? undefined : snapshot.historyId;
  const recordings = [];
  for (const recordingId of await integrations.heldRecordings()) {
    if (recordingId === running) continue;
    const entry = await deps.history?.get(recordingId);
    // Only once the files are saved: data is not released for a recording whose
    // files were not (E7). A failed save stays held until saving again completes it.
    if (!entry || entry.deletedAt || entry.status !== 'complete' || pendingLocalDeliveries(entry).length) continue;
    const expected = await deps.destinations?.routesForRecording(recordingId) ?? [];
    recordings.push({ recordingId, name: entry.name, routes: await integrations.recordingRoutes(recordingId, expected) });
  }
  return recordings;
}
