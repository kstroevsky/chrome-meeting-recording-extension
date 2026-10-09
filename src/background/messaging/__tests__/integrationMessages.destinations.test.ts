import { isPopupToBgMessage } from '../../../shared/protocol';
import { handleIntegrationMessage } from '../integrationMessages';

const ROUTES = [{ destinationId: 'destination_crm', mode: 'auto' as const }];
const VIEW = [{ destinationId: 'destination_crm', destinationName: 'CRM', state: 'held' as const }];
const CANDIDATES = [{ destinationId: 'destination_journal', destinationName: 'Journal' }];

function deps(historyId?: string) {
  const integrations = {
    confirmRecordingRoutes: jest.fn(async () => {}),
    changeRecordingRoute: jest.fn(async (): Promise<'changed' | 'stale' | 'unavailable'> => 'changed'),
    beginRecordingRouting: jest.fn(async () => ({ scheduled: ['destination_crm'], unavailable: [] })),
    retryRecordingRouting: jest.fn(async () => ({ scheduled: ['destination_crm'], unavailable: [] })),
    recordingRoutes: jest.fn(async () => VIEW),
    recordingRouteCandidates: jest.fn(async () => CANDIDATES),
    setDestinationEnabled: jest.fn(async (_id: string, enabled: boolean) => ({ id: 'destination_crm', enabled })),
    disconnectImpact: jest.fn(async () => ({ affectedRecordings: 63 })),
  };
  const destinations = {
    list: jest.fn(async () => ({ destinations: [], rememberedId: 'profile-crm' })),
    save: jest.fn(async () => ({ id: 'profile-crm' })),
    remove: jest.fn(async () => true),
    routesForRecording: jest.fn(async () => ROUTES),
  };
  const session = { getSnapshot: () => ({ historyId }) };
  const externalMedia = {
    reconcileRecording: jest.fn(async () => {}),
    cancelDestination: jest.fn(async () => {}),
    cancelDestinationStrict: jest.fn(async () => {}),
    userStatuses: jest.fn(async () => [{ recordingId: 'r1', state: 'uploading' }]),
    retryTransfer: jest.fn(async () => ({ recordingId: 'r1', state: 'queued' })),
  };
  const history = {
    replaceExternalPrimaryDestination: jest.fn(async () => true),
  };
  const L = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { integrations, destinations, externalMedia, history,
    all: { integrations, destinations, externalMedia, history, session, L } as never };
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
    expect(ctx.integrations.recordingRouteCandidates).toHaveBeenCalledWith('history-live', ROUTES);
    expect(respond).toHaveBeenCalledWith({
      ok: true, recordingId: 'history-live', routes: VIEW, candidates: CANDIDATES,
    });
  });

  it('answers no routes when nothing is recording and no recording is named', async () => {
    const respond = jest.fn();
    await handleIntegrationMessage({ type: 'GET_RECORDING_ROUTES' }, respond, deps().all);
    expect(respond).toHaveBeenCalledWith({ ok: true, routes: [] });
  });

  it('confirms only explicit route decisions, and retries with the profile\'s routes', async () => {
    const ctx = deps();
    const decisions = [{ destinationId: 'destination_crm', action: 'skip' as const }];
    await handleIntegrationMessage(
      { type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1', decisions },
      jest.fn(),
      ctx.all,
    );
    expect(ctx.integrations.confirmRecordingRoutes).toHaveBeenCalledWith('r1', decisions);
    expect(ctx.externalMedia.reconcileRecording).toHaveBeenCalledWith('r1');
    await handleIntegrationMessage({ type: 'RETRY_RECORDING_ROUTING', recordingId: 'r1' }, jest.fn(), ctx.all);
    expect(ctx.integrations.retryRecordingRouting).toHaveBeenCalledWith('r1', ROUTES);
  });

  it('changes a route only through the explicit end-dialog command', async () => {
    const ctx = deps();
    const respond = jest.fn();
    await handleIntegrationMessage({
      type: 'CHANGE_RECORDING_ROUTE',
      recordingId: 'r1',
      fromDestinationId: 'destination_crm',
      toDestinationId: 'destination_journal',
    }, respond, ctx.all);

    expect(ctx.integrations.changeRecordingRoute).toHaveBeenCalledWith(
      'r1', 'destination_crm', 'destination_journal',
    );
    expect(ctx.history.replaceExternalPrimaryDestination).toHaveBeenCalledWith(
      'r1', 'destination_crm', 'destination_journal',
    );
    expect(respond).toHaveBeenCalledWith({
      ok: true, recordingId: 'r1', routes: VIEW, candidates: CANDIDATES,
    });
  });

  it('reports a stale route change without releasing or reconciling anything', async () => {
    const ctx = deps();
    ctx.integrations.changeRecordingRoute.mockResolvedValueOnce('stale');
    const respond = jest.fn();
    await handleIntegrationMessage({
      type: 'CHANGE_RECORDING_ROUTE', recordingId: 'r1',
      fromDestinationId: 'destination_crm', toDestinationId: 'destination_journal',
    }, respond, ctx.all);

    expect(respond).toHaveBeenCalledWith({
      ok: false, error: 'This recording routing decision is stale; refresh and try again',
    });
    expect(ctx.externalMedia.reconcileRecording).not.toHaveBeenCalled();
  });

  it('disables automation and cancels media work without disconnecting the integration', async () => {
    const ctx = deps();
    const respond = jest.fn();

    await handleIntegrationMessage(
      { type: 'SET_INTEGRATION_ENABLED', destinationId: 'destination_crm', enabled: false },
      respond,
      ctx.all,
    );

    expect(ctx.integrations.setDestinationEnabled).toHaveBeenCalledWith('destination_crm', false);
    expect(ctx.externalMedia.cancelDestination).toHaveBeenCalledWith('destination_crm');
    expect(ctx.externalMedia.cancelDestinationStrict).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      destination: { id: 'destination_crm', enabled: false },
    });
  });

  it('reports disconnect impact and stops local work before deleting credentials', async () => {
    const ctx = deps();
    const order: string[] = [];
    ctx.integrations.setDestinationEnabled.mockImplementation(async () => {
      order.push('disable');
      return { id: 'destination_crm', enabled: false };
    });
    ctx.externalMedia.cancelDestinationStrict.mockImplementation(async () => { order.push('cancel-media'); });
    (ctx.integrations as any).deleteDestination = jest.fn(async () => {
      order.push('delete');
      return { removed: true };
    });
    const respond = jest.fn();

    await handleIntegrationMessage(
      { type: 'GET_INTEGRATION_DISCONNECT_IMPACT', destinationId: 'destination_crm' },
      respond,
      ctx.all,
    );
    expect(respond).toHaveBeenLastCalledWith({ ok: true, affectedRecordings: 63 });

    await handleIntegrationMessage(
      { type: 'DELETE_INTEGRATION', destinationId: 'destination_crm' },
      respond,
      ctx.all,
    );

    expect(order).toEqual(['disable', 'cancel-media', 'delete']);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, removed: true });
  });

  it('lists sanitized media progress and routes explicit retry through the media coordinator', async () => {
    const ctx = deps();
    const respond = jest.fn();

    await handleIntegrationMessage(
      { type: 'LIST_EXTERNAL_MEDIA_TRANSFERS', recordingId: 'r1' },
      respond,
      ctx.all,
    );
    expect(ctx.externalMedia.userStatuses).toHaveBeenCalledWith('r1');
    expect(respond).toHaveBeenLastCalledWith({
      ok: true,
      transfers: [{ recordingId: 'r1', state: 'uploading' }],
    });

    await handleIntegrationMessage(
      { type: 'RETRY_EXTERNAL_MEDIA_TRANSFER', destinationId: 'crm', clientTransferId: 'transfer-1' },
      respond,
      ctx.all,
    );
    expect(ctx.externalMedia.retryTransfer).toHaveBeenCalledWith('crm', 'transfer-1');
    expect(isPopupToBgMessage({
      type: 'RETRY_EXTERNAL_MEDIA_TRANSFER',
      destinationId: 'crm',
      clientTransferId: 'transfer-1',
    })).toBe(true);
  });

  it('lists finished recordings whose routes still wait, leaving out ones another prompt owns', async () => {
    const entries: Record<string, object> = {
      done: { id: 'done', name: 'Acme interview', status: 'complete', files: [] },
      saving: { id: 'saving', name: 'Still saving', status: 'saving', files: [] },
      partial: { id: 'partial', name: 'Download failed', status: 'partial', files: [] },
      removed: { id: 'removed', name: 'Removed', status: 'complete', files: [], deletedAt: 5 },
      awaiting: {
        id: 'awaiting', name: 'Awaiting the dialog', status: 'complete',
        files: [{ id: 'f1', kind: 'tab', delivery: { requested: 'local', status: 'pending' }, locations: [{ kind: 'opfs' }] }],
      },
    };
    const ctx = deps('live');
    const all = {
      ...(ctx.all as object),
      session: { getSnapshot: () => ({ historyId: 'live', phase: 'recording' }) },
      integrations: { ...ctx.integrations, heldRecordings: jest.fn(async () => ['live', 'done', 'saving', 'partial', 'removed', 'awaiting', 'gone']) },
      history: { get: jest.fn(async (id: string) => entries[id]) },
    } as never;
    const respond = jest.fn();

    await handleIntegrationMessage({ type: 'LIST_HELD_RECORDING_ROUTES' }, respond, all);
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      recordings: [{ recordingId: 'done', name: 'Acme interview', routes: VIEW }],
    });
    expect(isPopupToBgMessage({ type: 'LIST_HELD_RECORDING_ROUTES' })).toBe(true);
  });

  it('adds a new integration to Save to, and still reports the integration when that fails', async () => {
    const created = { destination: { id: 'destination_new', name: 'Journal' }, signingSecret: 'whsec_x' };
    const ctx = deps();
    const warn = jest.fn();
    const all = {
      ...(ctx.all as object),
      L: { log: jest.fn(), warn, error: jest.fn() },
      integrations: { ...ctx.integrations, createDestination: jest.fn(async () => created) },
    } as never;
    const respond = jest.fn();
    const message = { type: 'CREATE_INTEGRATION' as const, input: {} as never };

    await handleIntegrationMessage(message, respond, all);
    expect(ctx.destinations.save).toHaveBeenCalledWith({ destinationId: 'destination_new' });
    expect(respond).toHaveBeenLastCalledWith({ ok: true, created, profile: { id: 'profile-crm' } });

    ctx.destinations.save.mockRejectedValueOnce(new Error('settings unwritable'));
    await handleIntegrationMessage(message, respond, all);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, created });
    expect(warn).toHaveBeenCalled();
  });

  it('validates the new messages at the protocol boundary', () => {
    expect(isPopupToBgMessage({ type: 'LIST_RECORDING_DESTINATIONS' })).toBe(true);
    expect(isPopupToBgMessage({ type: 'SET_INTEGRATION_ENABLED', destinationId: 'd', enabled: false })).toBe(true);
    expect(isPopupToBgMessage({ type: 'SET_INTEGRATION_ENABLED', destinationId: 'd', enabled: 'no' })).toBe(false);
    expect(isPopupToBgMessage({ type: 'GET_INTEGRATION_DISCONNECT_IMPACT', destinationId: 'd' })).toBe(true);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: 'd', name: 'CRM' } })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'SAVE_RECORDING_DESTINATION',
      input: {
        name: 'Drive + CRM',
        mediaTarget: { kind: 'drive', folderPresetId: 'folder-1' },
        dataRoutes: [
          { destinationId: 'd', mode: 'auto' },
          { destinationId: 'journal', mode: 'auto' },
        ],
      },
    })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { mediaTarget: { kind: 'local' }, dataRoutes: [] },
    })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { mediaTarget: { kind: 'external', destinationId: 'd' }, dataRoutes: [] },
    })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { mediaTarget: { kind: 'external' }, dataRoutes: [] },
    })).toBe(false);
    expect(isPopupToBgMessage({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { mediaTarget: { kind: 'local' }, dataRoutes: [{ destinationId: 'd', mode: 'review' }] },
    })).toBe(false);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: '' } })).toBe(false);
    expect(isPopupToBgMessage({ type: 'SAVE_RECORDING_DESTINATION', input: { destinationId: 'd', id: 7 } })).toBe(false);
    expect(isPopupToBgMessage({ type: 'REMOVE_RECORDING_DESTINATION', profileId: ' ' })).toBe(false);
    expect(isPopupToBgMessage({ type: 'GET_RECORDING_ROUTES' })).toBe(true);
    expect(isPopupToBgMessage({ type: 'GET_RECORDING_ROUTES', recordingId: '' })).toBe(false);
    expect(isPopupToBgMessage({
      type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1',
      decisions: [{ destinationId: 'd', action: 'release' }],
    })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1',
      decisions: [{ destinationId: 'd', action: 'send' }],
    })).toBe(false);
    expect(isPopupToBgMessage({
      type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1',
      decisions: [
        { destinationId: 'd', action: 'release' },
        { destinationId: 'd', action: 'skip' },
      ],
    })).toBe(false);
    expect(isPopupToBgMessage({ type: 'CONFIRM_RECORDING_ROUTES', recordingId: 'r1' })).toBe(false);
    expect(isPopupToBgMessage({
      type: 'CHANGE_RECORDING_ROUTE', recordingId: 'r1',
      fromDestinationId: 'd', toDestinationId: 'journal',
    })).toBe(true);
    expect(isPopupToBgMessage({
      type: 'CHANGE_RECORDING_ROUTE', recordingId: 'r1',
      fromDestinationId: 'd', toDestinationId: 'd',
    })).toBe(false);
  });
});
