import { isPopupToBgMessage } from '../../../shared/protocol';
import { handleIntegrationMessage } from '../integrationMessages';

const ROUTES = [{ destinationId: 'destination_crm', mode: 'auto' as const }];
const VIEW = [{ destinationId: 'destination_crm', destinationName: 'CRM', state: 'held' as const }];

function deps(historyId?: string) {
  const integrations = {
    confirmRecordingRoutes: jest.fn(async () => {}),
    beginRecordingRouting: jest.fn(async () => ({ scheduled: ['destination_crm'], unavailable: [] })),
    recordingRoutes: jest.fn(async () => VIEW),
  };
  const destinations = {
    list: jest.fn(async () => ({ destinations: [], rememberedId: 'profile-crm' })),
    save: jest.fn(async () => ({ id: 'profile-crm' })),
    remove: jest.fn(async () => true),
    routesForRecording: jest.fn(async () => ROUTES),
  };
  const session = { getSnapshot: () => ({ historyId }) };
  return { integrations, destinations, all: { integrations, destinations, session } as never };
}

describe('destination and routing messages', () => {
  it('lists, saves and removes destinations through the destinations owner', async () => {
    const ctx = deps();
    const respond = jest.fn();
    await handleIntegrationMessage({ type: 'LIST_RECORDING_DESTINATIONS' }, respond, ctx.all);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, destinations: [], rememberedId: 'profile-crm' });
    await handleIntegrationMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: 'destination_crm' } }, respond, ctx.all);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, profile: { id: 'profile-crm' } });
    await handleIntegrationMessage({ type: 'REMOVE_RECORDING_DESTINATION', profileId: 'profile-crm' }, respond, ctx.all);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, removed: true });
  });

  it('describes the run in progress when no recording is named', async () => {
    const ctx = deps('history-live');
    const respond = jest.fn();
    await handleIntegrationMessage({ type: 'GET_RECORDING_ROUTES' }, respond, ctx.all);
    expect(ctx.integrations.recordingRoutes).toHaveBeenCalledWith('history-live', ROUTES);
    expect(respond).toHaveBeenCalledWith({ ok: true, recordingId: 'history-live', routes: VIEW });
  });

  it('answers no routes when nothing is recording and no recording is named', async () => {
    const respond = jest.fn();
    await handleIntegrationMessage({ type: 'GET_RECORDING_ROUTES' }, respond, deps().all);
    expect(respond).toHaveBeenCalledWith({ ok: true, routes: [] });
  });

  it('confirms with the removed destinations, and retries with the profile\'s routes', async () => {
    const ctx = deps();
    await handleIntegrationMessage(
      { type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1', removedDestinationIds: ['destination_crm'] },
      jest.fn(),
      ctx.all,
    );
    expect(ctx.integrations.confirmRecordingRoutes).toHaveBeenCalledWith('r1', ['destination_crm']);
    await handleIntegrationMessage({ type: 'RETRY_RECORDING_ROUTING', recordingId: 'r1' }, jest.fn(), ctx.all);
    expect(ctx.integrations.beginRecordingRouting).toHaveBeenCalledWith('r1', ROUTES);
  });

  it('validates the new messages at the protocol boundary', () => {
    expect(isPopupToBgMessage({ type: 'LIST_RECORDING_DESTINATIONS' })).toBe(true);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: 'd', name: 'CRM' } })).toBe(true);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: '' } })).toBe(false);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: 'd', id: 7 } })).toBe(false);
    expect(isPopupToBgMessage({ type: 'REMOVE_RECORDING_DESTINATION', profileId: ' ' })).toBe(false);
    expect(isPopupToBgMessage({ type: 'GET_RECORDING_ROUTES' })).toBe(true);
    expect(isPopupToBgMessage({ type: 'GET_RECORDING_ROUTES', recordingId: '' })).toBe(false);
    expect(isPopupToBgMessage({ type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1', removedDestinationIds: [] })).toBe(true);
    expect(isPopupToBgMessage({ type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1', removedDestinationIds: [1] })).toBe(false);
    expect(isPopupToBgMessage({ type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1' })).toBe(false);
  });
});
