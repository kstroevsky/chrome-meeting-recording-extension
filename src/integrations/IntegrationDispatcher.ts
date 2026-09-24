import type { IntegrationDataPolicy } from './contracts';
import { createIntegrationId } from './ids';
import {
  assertIntegrationPayloadWithinLimit,
  INTEGRATION_MAX_PAYLOAD_BYTES,
  IntegrationPayloadTooLargeError,
} from './payload';
import type {
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationRequestAuth,
  IntegrationSecret,
  IntegrationSpeakerAlias,
  IntegrationStream,
} from './persistence';
import { intersectIntegrationPolicy } from './policy';
import {
  classifyHttpFailure,
  INTEGRATION_MAX_AUTOMATIC_ATTEMPTS,
  integrationRetryDelayMs,
} from './IntegrationRetryPolicy';
import { sha256Hex, stableJsonSerialize } from './serialization';
import { normalizeWebhookEndpoint } from './webhook/WebhookEndpoint';
import { type ResolvedWebhookRequestAuth } from './webhook/WebhookAuth';
import { WebhookTransportError, type WebhookTransportResult } from './webhook/WebhookTransport';

type SnapshotEnvelope = {
  eventTypePrefix: string;
  eventKind: 'recording.ready.v1' | 'recording.updated.v1';
  eventId: string;
  eventTime: number;
  producerId: string;
  externalRecordingId: string;
  revision: number;
};

type BuiltSnapshot = {
  body: string;
  totalBytes: number;
  transcriptBytes: number;
  otherBytes: number;
  readiness: { complete: boolean; release: 'complete' | 'timeout' | 'manual'; pending: string[] };
  speakerAliases?: IntegrationSpeakerAlias[];
};

type DispatcherDeps = {
  destinations: { get(id: string): Promise<IntegrationDestination | undefined> };
  secrets: { get(id: string): Promise<IntegrationSecret | undefined> };
  streams: { get(destinationId: string, recordingId: string): Promise<IntegrationStream | undefined> };
  deliveries: {
    get(id: string): Promise<IntegrationDelivery | undefined>;
    put(delivery: IntegrationDelivery): Promise<void>;
  };
  snapshots: {
    build(
      recordingId: string,
      policy: IntegrationDataPolicy,
      envelope: SnapshotEnvelope,
      currentSpeakerAliases?: readonly IntegrationSpeakerAlias[],
    ): Promise<BuiltSnapshot>;
  };
  unitOfWork: {
    supersedeDelivery(
      previous: IntegrationDelivery,
      replacement: IntegrationDelivery,
      stream: IntegrationStream,
    ): Promise<void>;
  };
  transport: {
    send(input: {
      endpoint: string;
      eventId: string;
      body: string;
      signingSecret: string;
      requestAuth: ResolvedWebhookRequestAuth;
    }): Promise<WebhookTransportResult>;
  };
  containsHostPermission(pattern: string): Promise<boolean>;
  eventTypePrefix: string;
  now?: () => number;
  random?: () => number;
  onStateChanged?: () => Promise<void>;
  maxConcurrent?: number;
};

/** Executes persisted delivery work; planning remains owned by IntegrationCoordinator. */
export class IntegrationDispatcher {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly concurrency: KeyedConcurrency;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.concurrency = new KeyedConcurrency(deps.maxConcurrent ?? 3);
  }

  async dispatch(deliveryId: string, preparedBody?: string): Promise<IntegrationDelivery> {
    const initial = await this.requireDelivery(deliveryId);
    return await this.concurrency.run(streamKey(initial), async () => {
      const current = await this.requireDelivery(deliveryId);
      if (!['pending', 'retrying', 'delivering'].includes(current.state)) return current;
      return await this.process(current, preparedBody);
    });
  }

  async retry(deliveryId: string): Promise<IntegrationDelivery> {
    const initial = await this.requireDelivery(deliveryId);
    return await this.concurrency.run(streamKey(initial), async () => {
      const delivery = await this.requireDelivery(deliveryId);
      if (delivery.state !== 'failed' && delivery.state !== 'action-required') {
        throw new Error('Only failed or action-required integration deliveries can be retried manually');
      }
      const destination = await this.deps.destinations.get(delivery.destinationId);
      if (!destination) return await this.cancel(delivery, 'destination-deleted');
      if (!delivery.allowedPolicy) {
        return await this.requireAction(delivery, 'authorization-ceiling-missing');
      }
      if (delivery.connectionVersion !== destination.connectionVersion) {
        return await this.rebindConnection(delivery, destination);
      }
      const pending: IntegrationDelivery = {
        ...delivery,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: this.now(),
        lastStatus: undefined,
        lastErrorCode: undefined,
        updatedAt: this.now(),
      };
      await this.deps.deliveries.put(pending);
      await this.stateChanged();
      return await this.process(pending);
    });
  }

  private async process(
    delivery: IntegrationDelivery,
    preparedBody?: string,
  ): Promise<IntegrationDelivery> {
    const destination = await this.deps.destinations.get(delivery.destinationId);
    if (!destination) return await this.cancel(delivery, 'destination-deleted');
    if (!delivery.allowedPolicy) return await this.requireAction(delivery, 'authorization-ceiling-missing');
    if (!destination.enabled) return await this.requireAction(delivery, 'destination-disabled');
    if (delivery.connectionVersion !== destination.connectionVersion) {
      return await this.requireAction(delivery, 'connection-version-changed');
    }
    const hostPermission = normalizeWebhookEndpoint(destination.endpoint).hostPermission;
    if (!await this.deps.containsHostPermission(hostPermission)) {
      return await this.requireAction(delivery, 'host-permission-missing');
    }

    const stream = await this.deps.streams.get(delivery.destinationId, delivery.recordingId);
    if (!stream) return await this.requireAction(delivery, 'delivery-stream-missing');

    const effectivePolicy = intersectIntegrationPolicy(delivery.allowedPolicy, destination.dataPolicy);
    let body = preparedBody;
    if (
      !body
      || stableJsonSerialize(effectivePolicy) !== stableJsonSerialize(delivery.allowedPolicy)
      || await sha256Hex(body) !== delivery.bodyHash
    ) {
      let snapshot: BuiltSnapshot;
      try {
        snapshot = await this.buildSnapshot(delivery, destination, stream, effectivePolicy);
        assertIntegrationPayloadWithinLimit(snapshot, INTEGRATION_MAX_PAYLOAD_BYTES);
      } catch (error) {
        if (error instanceof IntegrationPayloadTooLargeError) {
          return await this.requireAction(delivery, 'payload-too-large');
        }
        return await this.cancel(delivery, 'recording-unavailable');
      }
      body = snapshot.body;
    }

    const bodyHash = await sha256Hex(body);
    if (!delivery.bodyHash) return await this.requireAction(delivery, 'body-hash-missing');
    if (bodyHash !== delivery.bodyHash) {
      return await this.supersedeChangedBody(delivery, destination, stream, effectivePolicy);
    }

    const delivering: IntegrationDelivery = {
      ...delivery,
      state: 'delivering',
      attemptCount: delivery.attemptCount + 1,
      updatedAt: this.now(),
    };
    delete delivering.nextAttemptAt;
    await this.deps.deliveries.put(delivering);
    await this.stateChanged();

    try {
      const result = await this.deps.transport.send({
        endpoint: destination.endpoint,
        eventId: delivery.eventId,
        body,
        signingSecret: await this.requireSecretValue(destination.signingSecretId),
        requestAuth: await this.resolveRequestAuth(destination.requestAuth),
      });
      if (!await this.deps.destinations.get(destination.id)) {
        return await this.cancel(delivering, 'destination-deleted');
      }
      const persistedAfterAttempt = await this.requireDelivery(delivering.id);
      if (persistedAfterAttempt.state === 'superseded' || persistedAfterAttempt.state === 'canceled') {
        return persistedAfterAttempt;
      }
      return result.ok
        ? await this.persistFinal(delivering, 'delivered', undefined, result.status)
        : await this.persistHttpFailure(delivering, result);
    } catch (error) {
      if (!await this.deps.destinations.get(destination.id)) {
        return await this.cancel(delivering, 'destination-deleted');
      }
      const persistedAfterAttempt = await this.requireDelivery(delivering.id);
      if (persistedAfterAttempt.state === 'superseded' || persistedAfterAttempt.state === 'canceled') {
        return persistedAfterAttempt;
      }
      const code = error instanceof WebhookTransportError ? error.code : 'transport-error';
      return await this.persistRetryableFailure(delivering, code);
    }
  }

  private async supersedeChangedBody(
    delivery: IntegrationDelivery,
    destination: IntegrationDestination,
    stream: IntegrationStream,
    policy: IntegrationDataPolicy,
  ): Promise<IntegrationDelivery> {
    const replacement = await this.buildReplacement(delivery, destination, stream, policy);
    if (replacement.delivery.state !== 'pending') return replacement.delivery;
    return await this.process(replacement.delivery, replacement.body);
  }

  private async rebindConnection(
    delivery: IntegrationDelivery,
    destination: IntegrationDestination,
  ): Promise<IntegrationDelivery> {
    const stream = await this.deps.streams.get(delivery.destinationId, delivery.recordingId);
    if (!stream) return await this.requireAction(delivery, 'delivery-stream-missing');
    const policy = intersectIntegrationPolicy(delivery.allowedPolicy!, destination.dataPolicy);
    const replacement = await this.buildReplacement(delivery, destination, stream, policy);
    if (replacement.delivery.state !== 'pending') return replacement.delivery;
    return await this.process(replacement.delivery, replacement.body);
  }

  private async buildReplacement(
    delivery: IntegrationDelivery,
    destination: IntegrationDestination,
    stream: IntegrationStream,
    policy: IntegrationDataPolicy,
  ): Promise<{ delivery: IntegrationDelivery; body: string }> {
    const now = this.now();
    const eventId = createIntegrationId('event');
    const revision = stream.nextRevision;
    const eventKind = 'recording.updated.v1' as const;
    let snapshot: BuiltSnapshot;
    try {
      snapshot = await this.deps.snapshots.build(
        delivery.recordingId,
        policy,
        {
          eventTypePrefix: this.deps.eventTypePrefix,
          eventKind,
          eventId,
          eventTime: now,
          producerId: destination.producerId,
          externalRecordingId: delivery.externalRecordingId,
          revision,
        },
        stream.speakerAliases,
      );
      assertIntegrationPayloadWithinLimit(snapshot, INTEGRATION_MAX_PAYLOAD_BYTES);
    } catch (error) {
      if (error instanceof IntegrationPayloadTooLargeError) {
        return {
          delivery: await this.requireAction(delivery, 'payload-too-large'),
          body: '',
        };
      }
      return {
        delivery: await this.cancel(delivery, 'recording-unavailable'),
        body: '',
      };
    }

    const replacement: IntegrationDelivery = {
      id: createIntegrationId('delivery'),
      destinationId: delivery.destinationId,
      recordingId: delivery.recordingId,
      externalRecordingId: delivery.externalRecordingId,
      eventId,
      eventType: eventKind,
      revision,
      eventTime: now,
      connectionVersion: destination.connectionVersion,
      allowedPolicy: { ...delivery.allowedPolicy! },
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      bodyHash: await sha256Hex(snapshot.body),
      totalBytes: snapshot.totalBytes,
      transcriptBytes: snapshot.transcriptBytes,
      createdAt: now,
      updatedAt: now,
    };
    const superseded: IntegrationDelivery = {
      ...delivery,
      state: 'superseded',
      lastErrorCode: 'body-changed',
      updatedAt: now,
    };
    delete superseded.nextAttemptAt;
    const nextStream: IntegrationStream = {
      ...stream,
      nextRevision: revision + 1,
      readyCreated: true,
      everAttempted: true,
      ...((snapshot.speakerAliases?.length || stream.speakerAliases?.length)
        ? { speakerAliases: snapshot.speakerAliases ?? stream.speakerAliases }
        : {}),
    };
    await this.deps.unitOfWork.supersedeDelivery(superseded, replacement, nextStream);
    await this.stateChanged();
    return { delivery: replacement, body: snapshot.body };
  }

  private async buildSnapshot(
    delivery: IntegrationDelivery,
    destination: IntegrationDestination,
    stream: IntegrationStream,
    policy: IntegrationDataPolicy,
  ): Promise<BuiltSnapshot> {
    if (delivery.eventType !== 'recording.ready.v1' && delivery.eventType !== 'recording.updated.v1') {
      throw new Error('Delivery event cannot be reconstructed as a recording snapshot');
    }
    return await this.deps.snapshots.build(
      delivery.recordingId,
      policy,
      {
        eventTypePrefix: this.deps.eventTypePrefix,
        eventKind: delivery.eventType,
        eventId: delivery.eventId,
        eventTime: delivery.eventTime,
        producerId: destination.producerId,
        externalRecordingId: delivery.externalRecordingId,
        revision: delivery.revision,
      },
      stream.speakerAliases,
    );
  }

  private async persistHttpFailure(
    delivery: IntegrationDelivery,
    result: WebhookTransportResult,
  ): Promise<IntegrationDelivery> {
    const state = classifyHttpFailure(result.status);
    if (state === 'retrying') {
      return await this.persistRetryableFailure(
        delivery,
        `http-${result.status}`,
        result.status,
        result.retryAfterMs,
      );
    }
    return await this.persistFinal(delivery, state, `http-${result.status}`, result.status);
  }

  private async persistRetryableFailure(
    delivery: IntegrationDelivery,
    code: string,
    status?: number,
    retryAfterMs?: number,
  ): Promise<IntegrationDelivery> {
    if (delivery.attemptCount >= INTEGRATION_MAX_AUTOMATIC_ATTEMPTS) {
      return await this.persistFinal(delivery, 'failed', code, status);
    }
    const delay = retryAfterMs ?? integrationRetryDelayMs(delivery.attemptCount, this.random);
    const retrying: IntegrationDelivery = {
      ...delivery,
      state: 'retrying',
      nextAttemptAt: this.now() + delay,
      lastStatus: status,
      lastErrorCode: code,
      updatedAt: this.now(),
    };
    await this.deps.deliveries.put(retrying);
    await this.stateChanged();
    return retrying;
  }

  private async persistFinal(
    delivery: IntegrationDelivery,
    state: IntegrationDelivery['state'],
    code?: string,
    status?: number,
  ): Promise<IntegrationDelivery> {
    const final: IntegrationDelivery = {
      ...delivery,
      state,
      lastStatus: status,
      lastErrorCode: code,
      updatedAt: this.now(),
    };
    delete final.nextAttemptAt;
    await this.deps.deliveries.put(final);
    await this.stateChanged();
    return final;
  }

  private cancel(delivery: IntegrationDelivery, code: string): Promise<IntegrationDelivery> {
    return this.persistFinal(delivery, 'canceled', code);
  }

  private requireAction(delivery: IntegrationDelivery, code: string): Promise<IntegrationDelivery> {
    return this.persistFinal(delivery, 'action-required', code, delivery.lastStatus);
  }

  private async requireDelivery(id: string): Promise<IntegrationDelivery> {
    const delivery = await this.deps.deliveries.get(id);
    if (!delivery) throw new Error('Integration delivery does not exist');
    return delivery;
  }

  private async requireSecretValue(id: string): Promise<string> {
    const secret = await this.deps.secrets.get(id);
    if (!secret) throw new Error('Integration credential is unavailable');
    return secret.value;
  }

  private async resolveRequestAuth(auth: IntegrationRequestAuth): Promise<ResolvedWebhookRequestAuth> {
    if (auth.type === 'none') return { type: 'none' };
    const value = await this.requireSecretValue(auth.secretId);
    return auth.type === 'bearer'
      ? { type: 'bearer', value }
      : { type: 'api-key', header: auth.header, value };
  }

  private async stateChanged(): Promise<void> {
    try {
      await this.deps.onStateChanged?.();
    } catch {
      // Durable outbox state remains authoritative; startup reconciliation can
      // reconstruct a missed alarm.
    }
  }
}

function streamKey(delivery: IntegrationDelivery): string {
  return `${delivery.destinationId}\u0000${delivery.recordingId}`;
}

class KeyedConcurrency {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly maxActive: number) {}

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseStream!: () => void;
    const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
      releaseStream();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}
