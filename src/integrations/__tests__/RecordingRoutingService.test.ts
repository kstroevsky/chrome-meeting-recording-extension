import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { IntegrationDataPolicy } from '../contracts';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationRoutingRepository } from '../IntegrationRoutingRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';
import { RecordingRoutingService } from '../RecordingRoutingService';
import type { IntegrationDelivery, IntegrationDestination } from '../persistence';
import { normalizeRecordingIntegrationIntent } from '../persistence';

const POLICY: IntegrationDataPolicy = { ...CONSERVATIVE_INTEGRATION_POLICY, metadata: true, transcript: true };
const ROUTE = [{ destinationId: 'destination_crm', mode: 'auto' as const }];
const MEDIA = {
  secretId: 'media_credential_1',
  capability: {
    version: 1 as const,
    apiBase: 'https://crm.example.test/api/media',
    upload: { strategy: 'multipart-put-v1' as const, origins: ['https://objects.example.test'] },
    playback: { strategy: 'refreshable-url-v1' as const },
  },
};
const MEDIA_AUTHORIZATION = {
  producerId: 'producer_crm', endpoint: 'https://crm.example.test/events',
  apiBase: 'https://crm.example.test/api/media',
  uploadOrigins: ['https://objects.example.test'],
};
const RELEASE_CRM = [{ destinationId: 'destination_crm', action: 'release' as const }];
const SKIP_CRM = [{ destinationId: 'destination_crm', action: 'skip' as const }];

function destination(overrides: Partial<IntegrationDestination> = {}): IntegrationDestination {
  return {
    id: 'destination_crm',
    producerId: 'producer_crm',
    name: 'CheekyCheeseIT CRM',
    type: 'webhook',
    enabled: true,
    endpoint: 'https://crm.example.test/events',
    routingDefault: 'manual',
    dataPolicy: POLICY,
    requestAuth: { type: 'none' },
    signingSecretId: 'secret_crm',
    connectionVersion: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function delivery(overrides: Partial<IntegrationDelivery>): IntegrationDelivery {
  return {
    id: 'delivery_1',
    destinationId: 'destination_crm',
    recordingId: 'recording_1',
    externalRecordingId: 'recording_ext',
    eventId: 'event_1',
    eventType: 'recording.ready.v1',
    revision: 1,
    eventTime: 5,
    connectionVersion: 3,
    allowedPolicy: POLICY,
    state: 'pending',
    attemptCount: 0,
    nextAttemptAt: 5,
    createdAt: 5,
    updatedAt: 5,
    ...overrides,
  };
}

function harness() {
  const factory = new IDBFactory();
  const destinations = new IntegrationDestinationRepository(factory);
  const routing = new IntegrationRoutingRepository(factory);
  const streams = new IntegrationStreamRepository(factory);
  const deliveries = new IntegrationDeliveryRepository(factory);
  const consider = jest.fn(async () => {});
  const service = new RecordingRoutingService({
    destinations,
    routing,
    streams,
    unitOfWork: new IntegrationUnitOfWork(factory),
    consider,
    now: () => 100,
  });
  const unitOfWork = new IntegrationUnitOfWork(factory);
  return { destinations, routing, streams, deliveries, consider, service, unitOfWork };
}

describe('RecordingRoutingService', () => {
  it('writes a held AUTO intent with policy and connection snapshots, plus the stream identity, at Start', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());

    await expect(ctx.service.begin('recording_1', ROUTE)).resolves.toEqual({ scheduled: ['destination_crm'], unavailable: [] });

    await expect(ctx.routing.get('recording_1')).resolves.toEqual({
      recordingId: 'recording_1',
      destinations: [{
        destinationId: 'destination_crm',
        mode: 'auto',
        state: 'selected',
        allowedPolicy: POLICY,
        connectionVersion: 3,
        releaseAfter: 'save-confirmed',
      }],
    });
    await expect(ctx.streams.get('destination_crm', 'recording_1')).resolves.toEqual(expect.objectContaining({
      externalRecordingId: expect.stringMatching(/^recording_/),
      nextRevision: 1,
      readyCreated: false,
      everAttempted: false,
    }));
    expect(ctx.consider).not.toHaveBeenCalled();
  });

  it('writes nothing for a missing or disabled destination and reports it', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination({ id: 'destination_off', enabled: false }));

    await expect(ctx.service.begin('recording_1', [
      { destinationId: 'destination_gone', mode: 'auto' },
      { destinationId: 'destination_off', mode: 'auto' },
    ])).resolves.toEqual({ scheduled: [], unavailable: ['destination_gone', 'destination_off'] });
    await expect(ctx.routing.get('recording_1')).resolves.toBeUndefined();
    await expect(ctx.streams.list()).resolves.toEqual([]);
  });

  it('holds video consent from Start, discloses it, and releases media with the data route', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination({ media: MEDIA }));
    await ctx.service.begin('recording_1', ROUTE);

    expect((await ctx.routing.get('recording_1'))?.destinations[0]?.mediaAuthorization).toEqual(MEDIA_AUTHORIZATION);
    expect(await ctx.service.routes('recording_1')).toEqual([{ destinationId: 'destination_crm',
      destinationName: 'CheekyCheeseIT CRM', state: 'held', includesMedia: true }]);
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);

    await ctx.service.confirm('recording_1', RELEASE_CRM);
    const [authorized] = await ctx.service.authorizedMediaRoutes('recording_1');
    expect(authorized).toEqual({ destinationId: 'destination_crm',
      externalRecordingId: (await ctx.streams.get('destination_crm', 'recording_1'))?.externalRecordingId,
      connectionVersion: 3, receiver: MEDIA_AUTHORIZATION });

    // Rotating a bearer for the same receiver does not retrospectively widen consent.
    await ctx.destinations.put(destination({ media: { ...MEDIA, secretId: 'media_credential_rotated' } }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([authorized]);

    // Changing the advertised storage receiver must not widen older Start-time consent.
    await ctx.destinations.put(destination({ media: {
      ...MEDIA,
      capability: {
        ...MEDIA.capability,
        upload: { ...MEDIA.capability.upload, origins: ['https://other-objects.example.test'] },
      },
    } }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
  });

  it('does not authorize older recordings when media is enabled after Start', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.service.begin('recording_1', ROUTE);
    await ctx.destinations.put(destination({ media: MEDIA }));
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
    await ctx.service.begin('recording_1', ROUTE); // Start may be replayed; older intent wins.
    expect((await ctx.routing.get('recording_1'))?.destinations[0]?.mediaAuthorization).toBeUndefined();
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
  });

  it('makes retrying a failed Start data-only even when media exists', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination({ media: MEDIA }));
    await ctx.service.begin('recording_1', ROUTE, false);
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
  });

  it('denies video export when the user skips, removes, or changes the receiver', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination({ media: MEDIA }));
    await ctx.service.begin('recording_skipped', ROUTE);
    await ctx.service.confirm('recording_skipped', SKIP_CRM);
    expect(await ctx.service.authorizedMediaRoutes('recording_skipped')).toEqual([]);

    await ctx.service.begin('recording_1', ROUTE);
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    await ctx.destinations.put(destination({ media: {
      ...MEDIA, capability: { ...MEDIA.capability, apiBase: 'https://crm.example.test/other' },
    } }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
    await ctx.destinations.put(destination({ media: MEDIA, connectionVersion: 4 }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
    await ctx.destinations.put(destination({ media: MEDIA, enabled: false }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
    await ctx.unitOfWork.deleteDestination(destination({ media: MEDIA }), 101);
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
  });

  it('strips Start-time media permission when receiver changes before the IDB transaction', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination()); // Actual row has no media.
    const service = new RecordingRoutingService({
      destinations: { get: async () => destination({ media: MEDIA }) },
      routing: ctx.routing, streams: ctx.streams, unitOfWork: ctx.unitOfWork, consider: ctx.consider,
    });
    await service.begin('recording_1', ROUTE);
    expect((await ctx.routing.get('recording_1'))?.destinations[0]?.mediaAuthorization).toBeUndefined();
  });

  it('treats malformed and legacy persisted consent as data-only', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination({ media: MEDIA }));
    const invalid = normalizeRecordingIntegrationIntent({ recordingId: 'recording_1', destinations: [{
      destinationId: 'destination_crm', mode: 'auto', state: 'selected', allowedPolicy: POLICY,
      connectionVersion: 3, mediaAuthorization: { ...MEDIA_AUTHORIZATION, endpoint: 'http://crm.example.test/events' },
    }] });
    expect(invalid?.destinations[0]?.mediaAuthorization).toBeUndefined();

    const legacy = normalizeRecordingIntegrationIntent({ recordingId: 'recording_legacy', destinations: [{
      destinationId: 'destination_crm', mode: 'auto', state: 'selected', allowedPolicy: POLICY,
      connectionVersion: 3, mediaAuthorization: {
        producerId: MEDIA_AUTHORIZATION.producerId,
        endpoint: MEDIA_AUTHORIZATION.endpoint,
        apiBase: MEDIA_AUTHORIZATION.apiBase,
      },
    }] });
    expect(legacy?.destinations[0]?.mediaAuthorization).toBeUndefined();

    await ctx.routing.put(invalid!);
    await ctx.streams.put({ destinationId: 'destination_crm', recordingId: 'recording_1',
      externalRecordingId: 'recording_old', nextRevision: 1, readyCreated: false, everAttempted: false });
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);
  });

  it('is additive: an existing entry for the same destination wins', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    const existing = {
      destinationId: 'destination_crm',
      mode: 'auto' as const,
      state: 'skipped' as const,
      allowedPolicy: POLICY,
      connectionVersion: 1,
    };
    await ctx.routing.put({ recordingId: 'recording_1', destinations: [existing] });

    await ctx.service.begin('recording_1', ROUTE);
    await expect(ctx.routing.get('recording_1')).resolves.toEqual({ recordingId: 'recording_1', destinations: [existing] });
  });

  it('keeps an existing stream identity instead of minting a second one', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.streams.put({
      destinationId: 'destination_crm', recordingId: 'recording_1', externalRecordingId: 'recording_kept',
      nextRevision: 4, readyCreated: true, everAttempted: true,
    });
    await ctx.service.begin('recording_1', ROUTE);
    await expect(ctx.streams.get('destination_crm', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ externalRecordingId: 'recording_kept', nextRevision: 4 }),
    );
  });

  it('releases kept routes, skips removed ones, and asks the planner to consider the recording', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.destinations.put(destination({ id: 'destination_journal', producerId: 'producer_journal', name: 'Journal' }));
    await ctx.service.begin('recording_1', [...ROUTE, { destinationId: 'destination_journal', mode: 'auto' }]);

    await ctx.service.confirm('recording_1', [
      { destinationId: 'destination_crm', action: 'release' },
      { destinationId: 'destination_journal', action: 'skip' },
    ]);

    const intent = await ctx.routing.get('recording_1');
    expect(intent?.destinations).toEqual([
      expect.not.objectContaining({ releaseAfter: expect.anything() }),
      expect.objectContaining({ destinationId: 'destination_journal', state: 'skipped' }),
    ]);
    expect(intent?.destinations[0]).toEqual(expect.objectContaining({ destinationId: 'destination_crm', state: 'selected' }));
    expect(intent?.destinations[1]).not.toHaveProperty('releaseAfter');
    expect(ctx.consider).toHaveBeenCalledWith('recording_1');
  });

  it('leaves routes a stale dialog never observed held', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.destinations.put(destination({
      id: 'destination_journal', producerId: 'producer_journal', name: 'Journal',
      endpoint: 'https://journal.example.test/events', signingSecretId: 'secret_journal',
    }));
    await ctx.service.begin('recording_1', ROUTE);

    await expect(ctx.service.change('recording_1', 'destination_crm', 'destination_journal')).resolves.toBe('changed');
    ctx.consider.mockClear();

    // This decision came from the dialog that still showed CRM. It must not
    // release Journal, which a newer explicit change added afterwards.
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    await expect(ctx.service.routes('recording_1')).resolves.toEqual([
      { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'skipped' },
      { destinationId: 'destination_journal', destinationName: 'Journal', state: 'held' },
    ]);
    expect(ctx.consider).not.toHaveBeenCalled();
  });

  it('atomically replaces a held receiver and captures fresh media consent for the explicit choice', async () => {
    const ctx = harness();
    const journalMedia = {
      secretId: 'media_journal',
      capability: {
        version: 1 as const,
        apiBase: 'https://journal.example.test/api/media',
        upload: { strategy: 'multipart-put-v1' as const, origins: ['https://journal-objects.example.test'] },
        playback: { strategy: 'refreshable-url-v1' as const },
      },
    };
    await ctx.destinations.put(destination({ media: MEDIA }));
    await ctx.destinations.put(destination({
      id: 'destination_journal', producerId: 'producer_journal', name: 'Journal',
      endpoint: 'https://journal.example.test/events', signingSecretId: 'secret_journal',
      connectionVersion: 7, media: journalMedia,
    }));
    await ctx.service.begin('recording_1', ROUTE);

    await expect(ctx.service.change('recording_1', 'destination_crm', 'destination_journal')).resolves.toBe('changed');
    const intent = await ctx.routing.get('recording_1');
    expect(intent?.destinations).toEqual([
      expect.objectContaining({ destinationId: 'destination_crm', state: 'skipped' }),
      expect.objectContaining({
        destinationId: 'destination_journal', state: 'selected', connectionVersion: 7,
        selectionSource: 'end-dialog',
        releaseAfter: 'save-confirmed',
        mediaAuthorization: {
          producerId: 'producer_journal',
          endpoint: 'https://journal.example.test/events',
          apiBase: 'https://journal.example.test/api/media',
          uploadOrigins: ['https://journal-objects.example.test'],
        },
      }),
    ]);
    expect(intent?.destinations[0]).not.toHaveProperty('releaseAfter');
    await expect(ctx.streams.get('destination_journal', 'recording_1')).resolves.toEqual(expect.objectContaining({
      destinationId: 'destination_journal',
      externalRecordingId: expect.stringMatching(/^recording_/),
      readyCreated: false,
      everAttempted: false,
    }));
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([]);

    await ctx.service.confirm('recording_1', [{ destinationId: 'destination_journal', action: 'release' }]);
    expect(await ctx.service.authorizedMediaRoutes('recording_1')).toEqual([
      expect.objectContaining({ destinationId: 'destination_journal', connectionVersion: 7 }),
    ]);
  });

  it('rejects a stale or unavailable receiver change without disturbing the held source', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.destinations.put(destination({
      id: 'destination_off', producerId: 'producer_off', name: 'Off', enabled: false,
      signingSecretId: 'secret_off',
    }));
    await ctx.service.begin('recording_1', ROUTE);

    await expect(ctx.service.change('recording_1', 'destination_crm', 'destination_off')).resolves.toBe('unavailable');
    await expect(ctx.service.routes('recording_1')).resolves.toEqual([
      { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'held' },
    ]);

    await ctx.service.confirm('recording_1', RELEASE_CRM);
    await ctx.destinations.put(destination({
      id: 'destination_journal', producerId: 'producer_journal', name: 'Journal', signingSecretId: 'secret_journal',
    }));
    await expect(ctx.service.change('recording_1', 'destination_crm', 'destination_journal')).resolves.toBe('stale');
    await expect(ctx.streams.get('destination_journal', 'recording_1')).resolves.toBeUndefined();
  });

  it('confirming twice is harmless, and confirming without an intent does nothing', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.service.begin('recording_1', ROUTE);
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    const once = await ctx.routing.get('recording_1');
    await ctx.service.confirm('recording_1', RELEASE_CRM);
    await expect(ctx.routing.get('recording_1')).resolves.toEqual(once);

    await expect(ctx.service.confirm('recording_none', RELEASE_CRM)).resolves.toBeUndefined();
  });

  it('lists recordings whose routes still wait for a confirmation', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.service.begin('recording_1', ROUTE);
    await ctx.service.begin('recording_2', ROUTE);
    await ctx.service.confirm('recording_2', RELEASE_CRM);
    await expect(ctx.service.held()).resolves.toEqual(['recording_1']);
  });

  it('describes routes for the end dialog, including ones that could not be scheduled', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.service.begin('recording_1', ROUTE);

    await expect(ctx.service.routes('recording_1', [
      ...ROUTE,
      { destinationId: 'destination_missing', mode: 'auto' },
    ])).resolves.toEqual([
      { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'held' },
      { destinationId: 'destination_missing', destinationName: null, state: 'not-scheduled' },
    ]);

    await ctx.service.confirm('recording_1', SKIP_CRM);
    await expect(ctx.service.routes('recording_1')).resolves.toEqual([
      { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'skipped' },
    ]);
  });

  it('does not write a route whose destination was deleted after it was looked up', async () => {
    const ctx = harness();
    // The lookup still sees the destination; the store no longer has it.
    const service = new RecordingRoutingService({
      destinations: { get: async () => destination() },
      routing: ctx.routing,
      streams: ctx.streams,
      unitOfWork: ctx.unitOfWork,
      consider: ctx.consider,
    });
    await service.begin('recording_1', ROUTE);
    await expect(ctx.routing.get('recording_1')).resolves.toBeUndefined();
    await expect(ctx.streams.list()).resolves.toEqual([]);
  });

  it('does not bring back a route whose destination was deleted before the confirmation', async () => {
    const ctx = harness();
    const crm = destination();
    await ctx.destinations.put(crm);
    await ctx.destinations.put(destination({ id: 'destination_journal', producerId: 'producer_journal', name: 'Journal' }));
    await ctx.service.begin('recording_1', [...ROUTE, { destinationId: 'destination_journal', mode: 'auto' }]);
    await ctx.unitOfWork.deleteDestination(crm, 50);

    await ctx.service.confirm('recording_1', [
      { destinationId: 'destination_crm', action: 'release' },
      { destinationId: 'destination_journal', action: 'release' },
    ]);
    const intent = await ctx.routing.get('recording_1');
    expect(intent?.destinations.map((entry) => entry.destinationId)).toEqual(['destination_journal']);
    expect(ctx.consider).toHaveBeenCalledWith('recording_1');
  });

  it('forgets a removed recording: intent gone, unsent work canceled, unattempted streams dropped', async () => {
    const ctx = harness();
    await ctx.destinations.put(destination());
    await ctx.service.begin('recording_1', ROUTE);
    await ctx.deliveries.put(delivery({ id: 'delivery_pending', eventId: 'event_pending', state: 'retrying' }));
    await ctx.deliveries.put(delivery({ id: 'delivery_done', eventId: 'event_done', revision: 2, state: 'delivered' }));
    await ctx.deliveries.put(delivery({ id: 'delivery_other', eventId: 'event_other', recordingId: 'recording_2' }));

    await ctx.service.forget('recording_1');

    await expect(ctx.routing.get('recording_1')).resolves.toBeUndefined();
    await expect(ctx.streams.get('destination_crm', 'recording_1')).resolves.toBeUndefined();
    const rows = Object.fromEntries((await ctx.deliveries.list()).map((row) => [row.id, row]));
    expect(rows.delivery_pending).toEqual(expect.objectContaining({ state: 'canceled', lastErrorCode: 'recording-removed', updatedAt: 100 }));
    expect(rows.delivery_pending).not.toHaveProperty('nextAttemptAt');
    expect(rows.delivery_done?.state).toBe('delivered');
    expect(rows.delivery_other?.state).toBe('pending');
  });

  it('keeps the stream of a recording the receiver already saw', async () => {
    const ctx = harness();
    await ctx.streams.put({
      destinationId: 'destination_crm', recordingId: 'recording_1', externalRecordingId: 'recording_seen',
      nextRevision: 2, readyCreated: true, everAttempted: true,
    });
    await ctx.service.forget('recording_1');
    await expect(ctx.streams.get('destination_crm', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ externalRecordingId: 'recording_seen' }),
    );
  });
});
