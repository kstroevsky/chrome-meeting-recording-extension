import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IntegrationCoordinator } from '../IntegrationCoordinator';
import { IntegrationDeliveryRepository } from '../IntegrationDeliveryRepository';
import { IntegrationDestinationRepository } from '../IntegrationDestinationRepository';
import { IntegrationSecretRepository } from '../IntegrationSecretRepository';
import { IntegrationStreamRepository } from '../IntegrationStreamRepository';
import { IntegrationUnitOfWork } from '../IntegrationUnitOfWork';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';
import { INTEGRATION_MAX_PAYLOAD_BYTES } from '../payload';
import { sha256Hex } from '../serialization';

const POLICY = {
  ...CONSERVATIVE_INTEGRATION_POLICY,
  metadata: true,
  transcript: true,
  transcriptSpeakers: 'pseudonyms' as const,
};

function runtime(options: { permission?: boolean; status?: number; payloadBytes?: number } = {}) {
  const factory = new IDBFactory();
  const destinations = new IntegrationDestinationRepository(factory);
  const secrets = new IntegrationSecretRepository(factory);
  const streams = new IntegrationStreamRepository(factory);
  const deliveries = new IntegrationDeliveryRepository(factory);
  const unitOfWork = new IntegrationUnitOfWork(factory);
  const bodies: string[] = [];
  const snapshots = {
    build: jest.fn(async (
      _recordingId: string,
      _policy: typeof POLICY,
      envelope: any,
      _currentSpeakerAliases?: readonly { speakerHash: string; ordinal: number }[],
    ) => {
      const body = options.payloadBytes
        ? 'x'.repeat(options.payloadBytes)
        : JSON.stringify({ id: envelope.eventId, revision: envelope.revision, type: envelope.eventKind });
      bodies.push(body);
      return {
        body,
        totalBytes: new TextEncoder().encode(body).byteLength,
        transcriptBytes: 0,
        otherBytes: new TextEncoder().encode(body).byteLength,
        readiness: { complete: true, release: 'complete' as const, pending: [] },
      };
    }),
  };
  const transportCalls: any[] = [];
  const transport = {
    send: jest.fn(async (input: any) => {
      transportCalls.push(input);
      return {
        ok: (options.status ?? 204) >= 200 && (options.status ?? 204) < 300,
        status: options.status ?? 204,
      };
    }),
  };
  let now = 1_000;
  const coordinator = new IntegrationCoordinator({
    destinations,
    secrets,
    streams,
    deliveries,
    unitOfWork,
    snapshots,
    transport,
    containsHostPermission: jest.fn(async () => options.permission ?? true),
    removeHostPermission: jest.fn(async () => true),
    eventTypePrefix: 'dev.workers.kstroevsky.meeting-recorder',
    now: () => ++now,
  });
  return { coordinator, destinations, secrets, streams, deliveries, snapshots, transport, transportCalls, bodies };
}

describe('IntegrationCoordinator', () => {
  it('requires exact host permission and exposes a signing secret only at creation', async () => {
    const denied = runtime({ permission: false });
    await expect(denied.coordinator.createDestination({
      name: 'CRM',
      endpoint: 'https://crm.example.test/hooks/recordings',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'none' },
    })).rejects.toThrow('Host permission is required for https://crm.example.test/*');
    await expect(denied.coordinator.listDestinations()).resolves.toEqual([]);

    const allowed = runtime();
    const created = await allowed.coordinator.createDestination({
      name: 'CRM',
      endpoint: 'https://crm.example.test/hooks/recordings',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'bearer', value: 'private-bearer' },
    });
    expect(created.signingSecret).toMatch(/^whsec_/);
    const listed = await allowed.coordinator.listDestinations();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret);
    expect(JSON.stringify(listed)).not.toContain('private-bearer');
  });

  it('uses the production transport for synthetic connection tests', async () => {
    const ctx = runtime();
    const { destination } = await ctx.coordinator.createDestination({
      name: 'Analyzer',
      endpoint: 'https://analyzer.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'api-key', header: 'x-api-key', value: 'private-key' },
    });

    await expect(ctx.coordinator.testDestination(destination.id)).resolves.toEqual(expect.objectContaining({
      ok: true,
      status: 204,
      eventId: expect.stringMatching(/^event_/),
    }));
    expect(ctx.transport.send).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://analyzer.example.test/events',
      eventId: expect.stringMatching(/^event_/),
      body: expect.stringContaining('.integration.test.v1'),
      signingSecret: expect.stringMatching(/^whsec_/),
      requestAuth: { type: 'api-key', header: 'x-api-key', value: 'private-key' },
    }));
  });

  it('rejects invalid API-key headers before persisting credentials', async () => {
    const ctx = runtime();
    await expect(ctx.coordinator.createDestination({
      name: 'Unsafe auth',
      endpoint: 'https://receiver.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'api-key', header: 'webhook-signature', value: 'private-key' },
    })).rejects.toThrow('Webhook API-key header conflicts with protocol headers');
    await expect(ctx.destinations.list()).resolves.toEqual([]);
    await expect(ctx.secrets.get('missing')).resolves.toBeUndefined();
  });

  it('persists delivery identity and hash before sending, then advances full-state revisions', async () => {
    const ctx = runtime();
    const { destination } = await ctx.coordinator.createDestination({
      name: 'CRM',
      endpoint: 'https://crm.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'none' },
    });

    const first = await ctx.coordinator.sendRecording(destination.id, 'recording:internal');
    expect(first).toEqual(expect.objectContaining({
      eventType: 'recording.ready.v1',
      revision: 1,
      state: 'delivered',
      attemptCount: 1,
      lastStatus: 204,
    }));
    expect(first.bodyHash).toBe(await sha256Hex(ctx.bodies[0]));
    expect(ctx.transportCalls[0]).toEqual(expect.objectContaining({
      eventId: first.eventId,
      body: ctx.bodies[0],
    }));
    const stream = await ctx.streams.get(destination.id, 'recording:internal');
    expect(stream).toEqual(expect.objectContaining({
      externalRecordingId: first.externalRecordingId,
      nextRevision: 2,
      readyCreated: true,
      everAttempted: true,
    }));

    const second = await ctx.coordinator.sendRecording(destination.id, 'recording:internal');
    expect(second).toEqual(expect.objectContaining({
      eventType: 'recording.updated.v1',
      revision: 2,
      externalRecordingId: first.externalRecordingId,
    }));
    await expect(ctx.deliveries.listStream(destination.id, 'recording:internal')).resolves.toHaveLength(2);
  });

  it('persists speaker aliases with the stream and supplies them to later revisions', async () => {
    const ctx = runtime();
    const { destination } = await ctx.coordinator.createDestination({
      name: 'CRM',
      endpoint: 'https://crm.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'none' },
    });
    const speakerAliases = [{ speakerHash: 'a'.repeat(64), ordinal: 1 }];
    ctx.snapshots.build.mockImplementationOnce(async (_recordingId, _policy, envelope) => {
      const body = JSON.stringify({ id: envelope.eventId, revision: envelope.revision });
      return {
        body,
        totalBytes: new TextEncoder().encode(body).byteLength,
        transcriptBytes: 0,
        otherBytes: new TextEncoder().encode(body).byteLength,
        readiness: { complete: true, release: 'complete' as const, pending: [] },
        speakerAliases,
      };
    });

    await ctx.coordinator.sendRecording(destination.id, 'recording:internal');
    await expect(ctx.streams.get(destination.id, 'recording:internal')).resolves.toEqual(
      expect.objectContaining({ speakerAliases }),
    );

    await ctx.coordinator.sendRecording(destination.id, 'recording:internal');
    expect(ctx.snapshots.build.mock.calls[1]?.[3]).toEqual(speakerAliases);
  });

  it('marks protocol/action failures without throwing away the durable delivery row', async () => {
    const ctx = runtime({ status: 413 });
    const { destination } = await ctx.coordinator.createDestination({
      name: 'Limited receiver',
      endpoint: 'https://receiver.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'none' },
    });

    const delivery = await ctx.coordinator.sendRecording(destination.id, 'recording:large');
    expect(delivery).toEqual(expect.objectContaining({
      state: 'action-required',
      lastStatus: 413,
      lastErrorCode: 'http-413',
    }));
    await expect(ctx.deliveries.get(delivery.id)).resolves.toEqual(delivery);
  });

  it('rejects an oversized serialized payload before planning or posting it', async () => {
    const ctx = runtime({ payloadBytes: INTEGRATION_MAX_PAYLOAD_BYTES + 1 });
    const { destination } = await ctx.coordinator.createDestination({
      name: 'Limited receiver',
      endpoint: 'https://receiver.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'none' },
    });

    await expect(ctx.coordinator.sendRecording(destination.id, 'recording:large'))
      .rejects.toMatchObject({
        name: 'IntegrationPayloadTooLargeError',
        maxBytes: INTEGRATION_MAX_PAYLOAD_BYTES,
      });
    expect(ctx.transport.send).not.toHaveBeenCalled();
    await expect(ctx.deliveries.list()).resolves.toEqual([]);
    await expect(ctx.streams.get(destination.id, 'recording:large')).resolves.toBeUndefined();
  });

  it('deletes credentials and cancels unresolved work before removing an unused host permission', async () => {
    const ctx = runtime();
    const { destination } = await ctx.coordinator.createDestination({
      name: 'CRM',
      endpoint: 'https://crm.example.test/events',
      routingDefault: 'manual',
      dataPolicy: POLICY,
      requestAuth: { type: 'bearer', value: 'private-bearer' },
    });
    const signingSecretId = destination.signingSecretId;
    const requestSecretId = destination.requestAuth.type === 'none'
      ? ''
      : destination.requestAuth.secretId;

    await ctx.coordinator.deleteDestination(destination.id);

    await expect(ctx.destinations.get(destination.id)).resolves.toBeUndefined();
    await expect(ctx.secrets.get(signingSecretId)).resolves.toBeUndefined();
    await expect(ctx.secrets.get(requestSecretId)).resolves.toBeUndefined();
  });
});
