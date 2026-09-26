import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { IntegrationDataPolicy, IntegrationReadiness } from '../contracts';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationEventPlanner } from '../IntegrationEventPlanner';
import { IntegrationRoutingRepository } from '../IntegrationRoutingRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';
import { stableJsonSerialize, utf8ByteLength } from '../serialization';

const BASE_POLICY: IntegrationDataPolicy = {
  ...CONSERVATIVE_INTEGRATION_POLICY,
  metadata: true,
};

type Source = {
  finalized: boolean;
  note?: string;
  analysis: 'none' | 'analyzing' | 'completed' | 'failed';
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
        totalBytes: utf8ByteLength(body),
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
    eventTypePrefix: 'dev.example',
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
    source,
    planner,
    streams,
    deliveries,
    destinations,
    seed,
    setNow(value: number) { now = value; },
  };
}

describe('IntegrationEventPlanner', () => {
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
});
