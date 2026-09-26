import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { IntegrationDataPolicy } from '../contracts';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationDispatcher } from '../IntegrationDispatcher';
import { IntegrationSecretRepository } from '../IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import type { IntegrationDelivery, IntegrationDestination } from '../persistence';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';
import { sha256Hex } from '../serialization';
import { WebhookTransportError } from '../webhook/WebhookTransport';

const BASE_POLICY: IntegrationDataPolicy = {
  ...CONSERVATIVE_INTEGRATION_POLICY,
  metadata: true,
  userNote: true,
};

type Result = { ok: boolean; status: number; retryAfterMs?: number };

function harness() {
  const factory = new IDBFactory();
  const destinations = new IntegrationDestinationRepository(factory);
  const secrets = new IntegrationSecretRepository(factory);
  const streams = new IntegrationStreamRepository(factory);
  const deliveries = new IntegrationDeliveryRepository(factory);
  const unitOfWork = new IntegrationUnitOfWork(factory);
  const canonical = {
    title: 'Architecture review',
    note: 'Retry the exact event.',
    transcript: 'private transcript',
  };
  const snapshots = {
    build: jest.fn(async (_recordingId: string, policy: IntegrationDataPolicy, envelope: any) => {
      const body = JSON.stringify({
        id: envelope.eventId,
        type: envelope.eventKind,
        time: envelope.eventTime,
        revision: envelope.revision,
        recording: {
          title: canonical.title,
          ...(policy.userNote ? { note: canonical.note } : {}),
          ...(policy.transcript ? { transcript: canonical.transcript } : {}),
        },
      });
      const totalBytes = new TextEncoder().encode(body).byteLength;
      return {
        body,
        totalBytes,
        transcriptBytes: policy.transcript ? canonical.transcript.length : 0,
        otherBytes: totalBytes,
        readiness: { complete: true, release: 'complete' as const, pending: [] },
      };
    }),
  };
  const behaviors: Array<Result | Error> = [];
  const transport = {
    send: jest.fn(async (_input: any) => {
      const next = behaviors.shift() ?? { ok: true, status: 204 };
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  let now = 1_000;
  const nowFn = () => now;
  const makeDispatcher = () => new IntegrationDispatcher({
    destinations,
    secrets,
    streams,
    deliveries,
    unitOfWork,
    snapshots,
    transport,
    containsHostPermission: async () => true,
    eventTypePrefix: 'dev.workers.kstroevsky.meeting-recorder',
    now: nowFn,
    random: () => 0.5,
  });

  const destination: IntegrationDestination = {
    id: 'destination_crm',
    producerId: 'producer_crm',
    name: 'CRM',
    type: 'webhook',
    enabled: true,
    endpoint: 'https://crm.example.test/events',
    routingDefault: 'manual',
    dataPolicy: BASE_POLICY,
    requestAuth: { type: 'none' },
    signingSecretId: 'secret_signing',
    connectionVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  async function initialize(): Promise<void> {
    await secrets.put({
      id: destination.signingSecretId,
      kind: 'signing',
      value: 'whsec_test-only',
      createdAt: 1,
      updatedAt: 1,
    });
    await destinations.put(destination);
  }

  async function plan(
    recordingId = 'recording_1',
    allowedPolicy: IntegrationDataPolicy = BASE_POLICY,
    revision = 1,
  ): Promise<{ delivery: IntegrationDelivery; body: string }> {
    const eventId = `event_${recordingId}_${revision}`;
    const eventTime = 100 + revision;
    const externalRecordingId = `external_${recordingId}`;
    const snapshot = await snapshots.build(recordingId, allowedPolicy, {
      eventTypePrefix: 'dev.workers.kstroevsky.meeting-recorder',
      eventKind: revision === 1 ? 'recording.ready.v1' : 'recording.updated.v1',
      eventId,
      eventTime,
      producerId: destination.producerId,
      externalRecordingId,
      revision,
    });
    const delivery: IntegrationDelivery = {
      id: `delivery_${recordingId}_${revision}`,
      destinationId: destination.id,
      recordingId,
      externalRecordingId,
      eventId,
      eventType: revision === 1 ? 'recording.ready.v1' : 'recording.updated.v1',
      revision,
      eventTime,
      connectionVersion: destination.connectionVersion,
      allowedPolicy: { ...allowedPolicy },
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      bodyHash: await sha256Hex(snapshot.body),
      totalBytes: snapshot.totalBytes,
      transcriptBytes: snapshot.transcriptBytes,
      createdAt: now,
      updatedAt: now,
    };
    await unitOfWork.planDelivery(delivery, {
      destinationId: destination.id,
      recordingId,
      externalRecordingId,
      nextRevision: revision + 1,
      readyCreated: true,
      everAttempted: true,
    });
    return { delivery, body: snapshot.body };
  }

  return {
    canonical,
    destinations,
    streams,
    deliveries,
    unitOfWork,
    transport,
    behaviors,
    destination,
    initialize,
    plan,
    makeDispatcher,
    setNow(value: number) { now = value; },
    getNow() { return now; },
  };
}

describe('IntegrationDispatcher', () => {
  it('retries 503 with bounded jitter and preserves the exact event identity/body', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push({ ok: false, status: 503 }, { ok: true, status: 204 });
    const dispatcher = ctx.makeDispatcher();

    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);
    expect(retrying).toEqual(expect.objectContaining({
      state: 'retrying',
      attemptCount: 1,
      lastStatus: 503,
      nextAttemptAt: ctx.getNow() + 15_000,
    }));
    const firstCall = ctx.transport.send.mock.calls[0]![0];

    ctx.setNow(retrying.nextAttemptAt!);
    const delivered = await dispatcher.dispatch(planned.delivery.id);
    expect(delivered).toEqual(expect.objectContaining({ state: 'delivered', attemptCount: 2 }));
    const secondCall = ctx.transport.send.mock.calls[1]![0];
    expect(secondCall.eventId).toBe(firstCall.eventId);
    expect(secondCall.body).toBe(firstCall.body);
  });

  it('uses Retry-After instead of local backoff for a retryable response', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push({ ok: false, status: 429, retryAfterMs: 120_000 });

    const retrying = await ctx.makeDispatcher().dispatch(planned.delivery.id, planned.body);
    expect(retrying).toEqual(expect.objectContaining({
      state: 'retrying',
      lastStatus: 429,
      nextAttemptAt: ctx.getNow() + 120_000,
    }));
  });

  it('retries network failures and recovers a lost response after dispatcher reconstruction', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push(new WebhookTransportError('network-error'), { ok: true, status: 204 });

    const retrying = await ctx.makeDispatcher().dispatch(planned.delivery.id, planned.body);
    expect(retrying).toEqual(expect.objectContaining({
      state: 'retrying',
      lastErrorCode: 'network-error',
    }));
    const committedRequest = ctx.transport.send.mock.calls[0]![0];

    ctx.setNow(retrying.nextAttemptAt!);
    const afterRestart = ctx.makeDispatcher();
    const delivered = await afterRestart.dispatch(planned.delivery.id);
    expect(delivered.state).toBe('delivered');
    expect(ctx.transport.send.mock.calls[1]![0]).toEqual(expect.objectContaining({
      eventId: committedRequest.eventId,
      body: committedRequest.body,
    }));
  });

  it('supersedes the old event atomically when canonical recording state changes', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push({ ok: false, status: 503 }, { ok: true, status: 204 });
    const dispatcher = ctx.makeDispatcher();
    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);
    ctx.canonical.title = 'Architecture review — revised';
    ctx.setNow(retrying.nextAttemptAt!);

    const replacement = await dispatcher.dispatch(planned.delivery.id);
    expect(replacement).toEqual(expect.objectContaining({
      state: 'delivered',
      revision: 2,
      eventType: 'recording.updated.v1',
    }));
    expect(replacement.eventId).not.toBe(planned.delivery.eventId);
    await expect(ctx.deliveries.get(planned.delivery.id)).resolves.toEqual(expect.objectContaining({
      state: 'superseded',
      lastErrorCode: 'body-changed',
    }));
    await expect(ctx.streams.get(ctx.destination.id, planned.delivery.recordingId)).resolves.toEqual(
      expect.objectContaining({ nextRevision: 3 }),
    );
  });

  it('applies destination-policy narrowing while preserving the original authorization ceiling', async () => {
    const ctx = harness();
    const allowed = { ...BASE_POLICY, transcript: true };
    ctx.destination.dataPolicy = allowed;
    await ctx.initialize();
    const planned = await ctx.plan('recording_private', allowed);
    ctx.behaviors.push({ ok: false, status: 503 }, { ok: true, status: 204 });
    const dispatcher = ctx.makeDispatcher();
    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);

    await ctx.destinations.put({
      ...ctx.destination,
      dataPolicy: { ...allowed, transcript: false },
      updatedAt: 2,
    });
    ctx.setNow(retrying.nextAttemptAt!);
    const replacement = await dispatcher.dispatch(planned.delivery.id);

    expect(replacement.revision).toBe(2);
    expect(replacement.allowedPolicy?.transcript).toBe(true);
    const sentBody = ctx.transport.send.mock.calls[1]![0].body as string;
    expect(sentBody).not.toContain('private transcript');
  });

  it('does not expose newly enabled data when a destination policy expands while queued', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan('recording_private', BASE_POLICY);
    ctx.behaviors.push({ ok: false, status: 503 }, { ok: true, status: 204 });
    const dispatcher = ctx.makeDispatcher();
    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);

    await ctx.destinations.put({
      ...ctx.destination,
      dataPolicy: { ...BASE_POLICY, transcript: true },
      updatedAt: 2,
    });
    ctx.setNow(retrying.nextAttemptAt!);
    const delivered = await dispatcher.dispatch(planned.delivery.id);

    expect(delivered.eventId).toBe(planned.delivery.eventId);
    expect(delivered.revision).toBe(1);
    const sentBody = ctx.transport.send.mock.calls[1]![0].body as string;
    expect(sentBody).not.toContain('private transcript');
  });

  it('cancels queued work when its destination was deleted', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push({ ok: false, status: 503 });
    const dispatcher = ctx.makeDispatcher();
    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);
    await ctx.destinations.remove(ctx.destination.id);
    ctx.setNow(retrying.nextAttemptAt!);

    await expect(dispatcher.dispatch(planned.delivery.id)).resolves.toEqual(expect.objectContaining({
      state: 'canceled',
      lastErrorCode: 'destination-deleted',
    }));
  });

  it('requires action after a connection change and creates a new event only on manual retry', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    ctx.behaviors.push({ ok: false, status: 503 }, { ok: true, status: 204 });
    const dispatcher = ctx.makeDispatcher();
    const retrying = await dispatcher.dispatch(planned.delivery.id, planned.body);
    await ctx.destinations.put({ ...ctx.destination, connectionVersion: 2, updatedAt: 2 });
    ctx.setNow(retrying.nextAttemptAt!);

    const blocked = await dispatcher.dispatch(planned.delivery.id);
    expect(blocked).toEqual(expect.objectContaining({
      state: 'action-required',
      lastErrorCode: 'connection-version-changed',
    }));
    expect(ctx.transport.send).toHaveBeenCalledTimes(1);

    const retried = await dispatcher.retry(planned.delivery.id);
    expect(retried).toEqual(expect.objectContaining({
      state: 'delivered',
      revision: 2,
      connectionVersion: 2,
    }));
    expect(retried.eventId).not.toBe(planned.delivery.eventId);
  });

  it('lets different recording streams progress concurrently while serializing one stream', async () => {
    const ctx = harness();
    await ctx.initialize();
    const a = await ctx.plan('recording_a');
    const b = await ctx.plan('recording_b');
    const resolvers: Array<(result: Result) => void> = [];
    let markTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => { markTwoStarted = resolve; });
    ctx.transport.send.mockImplementation(async () => await new Promise<Result>((resolve) => {
      resolvers.push(resolve);
      if (resolvers.length === 2) markTwoStarted();
    }));
    const dispatcher = ctx.makeDispatcher();

    const first = dispatcher.dispatch(a.delivery.id, a.body);
    const duplicate = dispatcher.dispatch(a.delivery.id, a.body);
    const second = dispatcher.dispatch(b.delivery.id, b.body);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      twoStarted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Independent delivery did not start')), 1_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(ctx.transport.send).toHaveBeenCalledTimes(2);
    resolvers.splice(0).forEach((resolve) => resolve({ ok: true, status: 204 }));
    await expect(Promise.all([first, duplicate, second])).resolves.toHaveLength(3);
    expect(ctx.transport.send).toHaveBeenCalledTimes(2);
  });

  it('stops automatic attempts at the configured bound and keeps the same event available for manual retry', async () => {
    const ctx = harness();
    await ctx.initialize();
    const planned = await ctx.plan();
    for (let attempt = 0; attempt < 6; attempt += 1) ctx.behaviors.push({ ok: false, status: 503 });
    const dispatcher = ctx.makeDispatcher();
    let current = await dispatcher.dispatch(planned.delivery.id, planned.body);
    while (current.state === 'retrying') {
      ctx.setNow(current.nextAttemptAt!);
      current = await dispatcher.dispatch(planned.delivery.id);
    }
    expect(current).toEqual(expect.objectContaining({ state: 'failed', attemptCount: 6 }));

    ctx.behaviors.push({ ok: true, status: 204 });
    const replayed = await dispatcher.retry(planned.delivery.id);
    expect(replayed).toEqual(expect.objectContaining({
      state: 'delivered',
      eventId: planned.delivery.eventId,
      revision: 1,
    }));
  });
});
