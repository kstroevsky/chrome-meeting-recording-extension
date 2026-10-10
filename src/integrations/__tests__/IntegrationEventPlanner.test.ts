import 'fake-indexeddb/auto';
import { INTEGRATION_EVENT_TYPE_PREFIX } from '../config';
import { IDBFactory } from 'fake-indexeddb';
import type { IntegrationDataPolicy, IntegrationReadiness } from '../contracts';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationEventPlanner } from '../IntegrationEventPlanner';
import { IntegrationReadinessScheduler } from '../IntegrationReadinessScheduler';
import { IntegrationRoutingRepository } from '../IntegrationRoutingRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';
import { RecordingRoutingService } from '../RecordingRoutingService';
import { stableJsonSerialize, utf8ByteLength } from '../serialization';

const BASE_POLICY: IntegrationDataPolicy = {
  ...CONSERVATIVE_INTEGRATION_POLICY,
  metadata: true,
};

type Source = {
  finalized: boolean;
  note?: string;
  analysis: 'none' | 'analyzing' | 'completed' | 'failed';
  /** Measures the built snapshot past the payload cap, as a very long transcript would. */
  oversized?: boolean;
};

function harness(policy: IntegrationDataPolicy, start = 1_000) {
  const factory = new IDBFactory();
  const destinations = new IntegrationDestinationRepository(factory);
  const routing = new IntegrationRoutingRepository(factory);
  const streams = new IntegrationStreamRepository(factory);
  const deliveries = new IntegrationDeliveryRepository(factory);
  const unitOfWork = new IntegrationUnitOfWork(factory);
  const source: Source = { finalized: true, analysis: 'none', note: 'first note' };
  let now = start;
  const evaluate = (_recordingId: string, effectivePolicy: IntegrationDataPolicy) => {
    const pending = effectivePolicy.analysis
      && (source.analysis === 'none' || source.analysis === 'analyzing')
      ? ['analysis' as const]
      : [];
    return { complete: pending.length === 0, pending };
  };
  const snapshots = {
    evaluateReadiness: jest.fn(async (recordingId: string, effectivePolicy: IntegrationDataPolicy) => (
      evaluate(recordingId, effectivePolicy)
    )),
    build: jest.fn(async (
      recordingId: string,
      effectivePolicy: IntegrationDataPolicy,
      envelope: {
        eventKind: 'recording.ready.v1' | 'recording.updated.v1';
        eventId: string;
        eventTime: number;
        externalRecordingId: string;
        revision: number;
      },
      _speakerAliases?: readonly unknown[],
      incompleteRelease: 'manual' | 'timeout' = 'manual',
    ) => {
      const evaluation = evaluate(recordingId, effectivePolicy);
      const readiness: IntegrationReadiness = {
        ...evaluation,
        release: evaluation.complete ? 'complete' : incompleteRelease,
      };
      const recording = {
        id: envelope.externalRecordingId,
        title: 'Recording',
        startedAt: '2026-09-26T10:00:00.000Z',
        source: { kind: 'tab' },
        ...(effectivePolicy.userNote && source.note ? { note: source.note } : {}),
        ...(effectivePolicy.analysis && source.analysis !== 'none'
          ? { analysis: { status: source.analysis } }
          : {}),
      };
      const body = stableJsonSerialize({
        specversion: '1.0',
        id: envelope.eventId,
        type: envelope.eventKind,
        time: new Date(envelope.eventTime).toISOString(),
        data: { revision: envelope.revision, readiness, recording },
      });
      return {
        body,
        totalBytes: source.oversized ? 3 * 1024 * 1024 : utf8ByteLength(body),
        transcriptBytes: 0,
        otherBytes: utf8ByteLength(body),
        readiness,
      };
    }),
  };
  const planner = new IntegrationEventPlanner({
    destinations,
    routing,
    streams,
    unitOfWork,
    snapshots,
    isRecordingFinalized: async () => source.finalized,
    eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
    readyTimeoutMs: 100,
    now: () => now,
  });

  const seed = async () => {
    await destinations.put({
      id: 'destination_1',
      producerId: 'producer_1',
      name: 'CRM',
      type: 'webhook',
      enabled: true,
      endpoint: 'https://crm.example.test/events',
      routingDefault: 'manual',
      dataPolicy: policy,
      requestAuth: { type: 'none' },
      signingSecretId: 'secret_1',
      connectionVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await routing.put({
      recordingId: 'recording_1',
      destinations: [{
        destinationId: 'destination_1',
        mode: 'auto',
        state: 'selected',
        allowedPolicy: policy,
        connectionVersion: 1,
      }],
    });
  };

  return {
    factory,
    source,
    planner,
    snapshots,
    streams,
    deliveries,
    destinations,
    routing,
    unitOfWork,
    seed,
    setNow(value: number) { now = value; },
  };
}

describe('IntegrationEventPlanner', () => {
  it('never exports event data for a media-only primary receiver intent', async () => {
    const ctx = harness(BASE_POLICY);
    await ctx.seed();
    await ctx.routing.put({
      recordingId: 'recording_1',
      destinations: [{
        destinationId: 'destination_1',
        mode: 'auto',
        state: 'selected',
        allowedPolicy: BASE_POLICY,
        connectionVersion: 1,
        mediaOnly: true,
      }],
    });

    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    expect(ctx.snapshots.build).not.toHaveBeenCalled();
    await expect(ctx.deliveries.listStream('destination_1', 'recording_1')).resolves.toEqual([]);
  });

  it('waits for pending requested data and emits ready when it settles', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();

    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({
      kind: 'wait',
      readyDeadlineAt: 1_100,
    });
    await expect(ctx.deliveries.list()).resolves.toEqual([]);
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ readyCreated: false, readyDeadlineAt: 1_100 }),
    );

    ctx.source.analysis = 'completed';
    const planned = await ctx.planner.consider('destination_1', 'recording_1');
    expect(planned).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({
        eventType: 'recording.ready.v1',
        revision: 1,
        readinessRelease: 'complete',
      }),
    }));
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({
        readyCreated: true,
        nextRevision: 2,
        lastPlannedProjectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('releases a partial ready snapshot at the durable deadline and updates after late completion', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    await ctx.planner.consider('destination_1', 'recording_1');

    ctx.setNow(1_100);
    const timedOut = await ctx.planner.consider('destination_1', 'recording_1');
    expect(timedOut).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({
        eventType: 'recording.ready.v1',
        revision: 1,
        readinessRelease: 'timeout',
      }),
    }));

    ctx.source.analysis = 'completed';
    ctx.setNow(1_200);
    const updated = await ctx.planner.consider('destination_1', 'recording_1');
    expect(updated).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({
        eventType: 'recording.updated.v1',
        revision: 2,
        readinessRelease: 'complete',
      }),
    }));
    await expect(ctx.deliveries.listStream('destination_1', 'recording_1')).resolves.toHaveLength(2);
  });

  it('waits only before the first send: a later change goes out at once, pending data and all', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true, userNote: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    await ctx.planner.consider('destination_1', 'recording_1');
    ctx.setNow(1_100);
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ kind: 'planned' }),
    );

    // Analysis is still running; the note change does not wait for it.
    ctx.source.note = 'revised note';
    ctx.setNow(1_150);
    const changed = await ctx.planner.consider('destination_1', 'recording_1');
    expect(changed).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({
        eventType: 'recording.updated.v1',
        revision: 2,
        readinessRelease: 'timeout',
      }),
    }));
    if (changed.kind !== 'planned') throw new Error('expected a planned update');
    expect(JSON.parse(changed.body).data.readiness).toEqual({ complete: false, release: 'timeout', pending: ['analysis'] });
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.not.objectContaining({ readyDeadlineAt: expect.any(Number) }),
    );
  });

  it('creates no revision when the destination-visible projection is unchanged', async () => {
    const ctx = harness(BASE_POLICY);
    await ctx.seed();
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ kind: 'planned' }),
    );

    ctx.setNow(2_000);
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.deliveries.listStream('destination_1', 'recording_1')).resolves.toHaveLength(1);
  });

  it('revisions exported note changes but ignores the same change when notes are disabled', async () => {
    const exported = harness({ ...BASE_POLICY, userNote: true });
    await exported.seed();
    await exported.planner.consider('destination_1', 'recording_1');
    exported.source.note = 'changed note';
    exported.setNow(2_000);
    await expect(exported.planner.consider('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({
        kind: 'planned',
        delivery: expect.objectContaining({ revision: 2, eventType: 'recording.updated.v1' }),
      }),
    );

    const hidden = harness(BASE_POLICY);
    await hidden.seed();
    await hidden.planner.consider('destination_1', 'recording_1');
    hidden.source.note = 'changed note';
    hidden.setNow(2_000);
    await expect(hidden.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(hidden.deliveries.listStream('destination_1', 'recording_1')).resolves.toHaveLength(1);
  });

  it('keeps manual partial delivery immediate and marked manual', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    const destination = await ctx.destinations.get('destination_1');
    if (!destination) throw new Error('destination missing');

    const planned = await ctx.planner.planManual(destination, 'recording_1');
    expect(planned).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({ readinessRelease: 'manual', revision: 1 }),
    }));
  });

  it('does not begin automatic readiness before recording finalization', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.finalized = false;
    ctx.source.analysis = 'analyzing';
    await ctx.seed();

    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toBeUndefined();
  });

  it('retires a durable readiness deadline when automatic routing is no longer active', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    await ctx.planner.consider('destination_1', 'recording_1');
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ readyDeadlineAt: 1_100 }),
    );

    await ctx.routing.remove('recording_1');
    ctx.setNow(1_100);
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.not.objectContaining({ readyDeadlineAt: expect.any(Number) }),
    );
  });

  it('parks an oversized automatic snapshot for Retry instead of rebuilding it on every wake-up', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    await ctx.planner.consider('destination_1', 'recording_1');
    ctx.source.oversized = true;
    ctx.setNow(1_100);

    const parked = await ctx.planner.consider('destination_1', 'recording_1');
    expect(parked).toEqual({ kind: 'action-required', delivery: expect.objectContaining({
      state: 'action-required',
      lastErrorCode: 'payload-too-large',
      readinessRelease: 'timeout',
      revision: 1,
    }) });
    if (parked.kind !== 'action-required') throw new Error('expected a parked delivery');
    expect(parked.delivery.nextAttemptAt).toBeUndefined();
    // The deadline is spent, so nothing wakes this stream again on its own.
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toEqual(
      expect.not.objectContaining({ readyDeadlineAt: expect.any(Number) }),
    );

    const alarms: number[] = [];
    const scheduler = new IntegrationReadinessScheduler({
      streams: ctx.streams,
      consider: async (destinationId, recordingId) => { await ctx.planner.consider(destinationId, recordingId); },
      createAlarm: async (_name, info) => { alarms.push(info.when!); },
      getAlarm: async () => undefined,
      clearAlarm: async () => true,
      now: () => 1_100,
    });
    await scheduler.runDue();
    expect(alarms).toEqual([]);

    // Later data is a new attempt, parked the same way; unchanged data is none.
    ctx.source.analysis = 'completed';
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual(
      expect.objectContaining({ kind: 'action-required' }),
    );
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.deliveries.listStream('destination_1', 'recording_1')).resolves.toEqual([
      expect.objectContaining({ revision: 1, state: 'action-required' }),
      expect.objectContaining({ revision: 2, state: 'action-required' }),
    ]);
  });

  it('still refuses an oversized manual send outright', async () => {
    const ctx = harness(BASE_POLICY);
    await ctx.seed();
    ctx.source.oversized = true;
    const destination = (await ctx.destinations.get('destination_1'))!;
    await expect(ctx.planner.planManual(destination, 'recording_1')).rejects.toThrow(/limit is/);
    expect(await ctx.deliveries.list()).toHaveLength(0);
  });
});

describe('IntegrationEventPlanner — routes held until the save is confirmed', () => {
  const hold = async (ctx: ReturnType<typeof harness>, releaseAfter?: 'save-confirmed') => {
    await ctx.routing.put({
      recordingId: 'recording_1',
      destinations: [{
        destinationId: 'destination_1',
        mode: 'auto',
        state: 'selected',
        allowedPolicy: BASE_POLICY,
        connectionVersion: 1,
        ...(releaseAfter ? { releaseAfter } : {}),
      }],
    });
  };

  it('plans nothing and starts no readiness deadline while the route is held', async () => {
    const ctx = harness({ ...BASE_POLICY, analysis: true });
    ctx.source.analysis = 'analyzing';
    await ctx.seed();
    await hold(ctx, 'save-confirmed');

    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.deliveries.list()).resolves.toEqual([]);
    await expect(ctx.streams.get('destination_1', 'recording_1')).resolves.toBeUndefined();
  });

  it('keeps the stream identity created at Start once the hold is released', async () => {
    const ctx = harness(BASE_POLICY);
    await ctx.seed();
    await hold(ctx, 'save-confirmed');
    await ctx.streams.put({
      destinationId: 'destination_1',
      recordingId: 'recording_1',
      externalRecordingId: 'recording_created-at-start',
      nextRevision: 1,
      readyCreated: false,
      everAttempted: false,
    });
    await expect(ctx.planner.consider('destination_1', 'recording_1')).resolves.toEqual({ kind: 'noop' });

    await hold(ctx);
    const planned = await ctx.planner.consider('destination_1', 'recording_1');
    expect(planned).toEqual(expect.objectContaining({
      kind: 'planned',
      delivery: expect.objectContaining({ externalRecordingId: 'recording_created-at-start', revision: 1 }),
    }));
  });

  it('round-trips releaseAfter through the routing repository', async () => {
    const ctx = harness(BASE_POLICY);
    await hold(ctx, 'save-confirmed');
    await expect(ctx.routing.get('recording_1')).resolves.toEqual(expect.objectContaining({
      destinations: [expect.objectContaining({ releaseAfter: 'save-confirmed' })],
    }));
  });

  it('keeps one removed end-dialog destination suppressed for both events and media after restart', async () => {
    const ctx = harness(BASE_POLICY);
    await ctx.seed();
    const destination = (await ctx.destinations.get('destination_1'))!;
    await ctx.destinations.put({
      ...destination,
      media: {
        secretId: 'media_credential_1',
        capability: {
          version: 1,
          apiBase: 'https://crm.example.test/api/media',
          upload: {
            strategy: 'multipart-put-v1',
            origins: ['https://objects.example.test'],
          },
          playback: { strategy: 'refreshable-url-v1' },
        },
      },
    });

    const recordingId = 'recording_removed-at-confirmation';
    const routing = new RecordingRoutingService({
      destinations: ctx.destinations,
      routing: ctx.routing,
      streams: ctx.streams,
      unitOfWork: ctx.unitOfWork,
      consider: async (id) => { await ctx.planner.consider('destination_1', id); },
    });
    await routing.begin(recordingId, [{ destinationId: 'destination_1', mode: 'auto' }]);

    expect(await routing.authorizedMediaRoutes(recordingId)).toEqual([]);
    await routing.confirm(recordingId, [{ destinationId: 'destination_1', action: 'skip' }]);
    expect(await ctx.routing.get(recordingId)).toEqual(expect.objectContaining({
      destinations: [expect.objectContaining({
        destinationId: 'destination_1',
        state: 'skipped',
      })],
    }));
    expect((await ctx.routing.get(recordingId))?.destinations[0]).not.toHaveProperty('releaseAfter');
    expect(await routing.authorizedMediaRoutes(recordingId)).toEqual([]);
    await expect(ctx.planner.consider('destination_1', recordingId)).resolves.toEqual({ kind: 'noop' });
    await expect(ctx.deliveries.listStream('destination_1', recordingId)).resolves.toEqual([]);

    // Recreate every routing/planning repository as a restarted service worker would.
    const restartedDestinations = new IntegrationDestinationRepository(ctx.factory);
    const restartedRouting = new IntegrationRoutingRepository(ctx.factory);
    const restartedStreams = new IntegrationStreamRepository(ctx.factory);
    const restartedDeliveries = new IntegrationDeliveryRepository(ctx.factory);
    const restartedUnitOfWork = new IntegrationUnitOfWork(ctx.factory);
    const restartedPlanner = new IntegrationEventPlanner({
      destinations: restartedDestinations,
      routing: restartedRouting,
      streams: restartedStreams,
      unitOfWork: restartedUnitOfWork,
      snapshots: ctx.snapshots,
      isRecordingFinalized: async () => ctx.source.finalized,
      eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
      readyTimeoutMs: 100,
      now: () => 1_000,
    });
    const restartedRoutes = new RecordingRoutingService({
      destinations: restartedDestinations,
      routing: restartedRouting,
      streams: restartedStreams,
      unitOfWork: restartedUnitOfWork,
      consider: async (id) => { await restartedPlanner.consider('destination_1', id); },
    });

    await expect(restartedRoutes.authorizedMediaRoutes(recordingId)).resolves.toEqual([]);
    await expect(restartedPlanner.consider('destination_1', recordingId)).resolves.toEqual({ kind: 'noop' });
    await expect(restartedDeliveries.listStream('destination_1', recordingId)).resolves.toEqual([]);
  });
});
