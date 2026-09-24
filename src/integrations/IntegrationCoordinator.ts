import type { IntegrationDataPolicy } from './contracts';
import { createIntegrationId } from './ids';
import { buildIntegrationTestPayload } from './IntegrationTestEvent';
import {
  parseCreateIntegrationDestinationInput,
  type CreateIntegrationDestinationInput,
  type CreatedIntegrationDestination,
  type IntegrationConnectionTestResult,
} from './management';
import {
  assertIntegrationPayloadWithinLimit,
  INTEGRATION_MAX_PAYLOAD_BYTES,
} from './payload';
import type {
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationRequestAuth,
  IntegrationSecret,
  IntegrationSpeakerAlias,
  IntegrationStream,
} from './persistence';
import { sha256Hex } from './serialization';
import { createStandardWebhookSecret } from './webhook/StandardWebhookSigner';
import { normalizeWebhookEndpoint } from './webhook/WebhookEndpoint';
import { normalizeWebhookApiKeyHeader, type ResolvedWebhookRequestAuth } from './webhook/WebhookAuth';
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

type CoordinatorDeps = {
  destinations: {
    get(id: string): Promise<IntegrationDestination | undefined>;
    list(): Promise<IntegrationDestination[]>;
  };
  secrets: {
    get(id: string): Promise<IntegrationSecret | undefined>;
  };
  streams: {
    get(destinationId: string, recordingId: string): Promise<IntegrationStream | undefined>;
  };
  deliveries: {
    put(delivery: IntegrationDelivery): Promise<void>;
    list(): Promise<IntegrationDelivery[]>;
  };
  snapshots: {
    build(
      recordingId: string,
      policy: IntegrationDataPolicy,
      envelope: SnapshotEnvelope,
      currentSpeakerAliases?: readonly IntegrationSpeakerAlias[],
    ): Promise<{
      body: string;
      totalBytes: number;
      transcriptBytes: number;
      otherBytes: number;
      readiness: { complete: boolean; release: 'complete' | 'timeout' | 'manual'; pending: string[] };
      speakerAliases?: IntegrationSpeakerAlias[];
    }>;
  };
  unitOfWork: {
    createDestination(destination: IntegrationDestination, secrets: IntegrationSecret[]): Promise<void>;
    planDelivery(delivery: IntegrationDelivery, stream: IntegrationStream): Promise<void>;
    deleteDestination(destination: IntegrationDestination, updatedAt: number): Promise<void>;
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
  removeHostPermission(pattern: string): Promise<boolean>;
  eventTypePrefix: string;
  now?: () => number;
};

export class IntegrationCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  listDestinations(): Promise<IntegrationDestination[]> {
    return this.deps.destinations.list();
  }

  async createDestination(input: CreateIntegrationDestinationInput): Promise<CreatedIntegrationDestination> {
    const normalized = parseCreateIntegrationDestinationInput(input);
    const { endpoint, hostPermission } = normalizeWebhookEndpoint(normalized.endpoint);
    await this.assertPermission(hostPermission);

    const now = this.now();
    const signingSecretId = createIntegrationId('secret');
    const signingSecret = createStandardWebhookSecret();
    const requestAuth = this.prepareRequestAuth(normalized.requestAuth, now);
    const destination: IntegrationDestination = {
      id: createIntegrationId('destination'),
      producerId: createIntegrationId('producer'),
      name: normalized.name,
      type: 'webhook',
      enabled: true,
      endpoint,
      routingDefault: normalized.routingDefault,
      dataPolicy: { ...normalized.dataPolicy },
      requestAuth: requestAuth.reference,
      signingSecretId,
      connectionVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const signingSecretRow: IntegrationSecret = {
      id: signingSecretId,
      kind: 'signing',
      value: signingSecret,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.unitOfWork.createDestination(
      destination,
      [signingSecretRow, ...(requestAuth.secret ? [requestAuth.secret] : [])],
    );
    return { destination, signingSecret };
  }

  async testDestination(destinationId: string): Promise<IntegrationConnectionTestResult> {
    const destination = await this.requireDestination(destinationId);
    await this.assertDestinationPermission(destination);
    const eventId = createIntegrationId('event');
    const body = buildIntegrationTestPayload({
      eventTypePrefix: this.deps.eventTypePrefix,
      eventId,
      eventTime: this.now(),
      producerId: destination.producerId,
    });
    const result = await this.deps.transport.send({
      endpoint: destination.endpoint,
      eventId,
      body,
      signingSecret: await this.requireSecretValue(destination.signingSecretId),
      requestAuth: await this.resolveRequestAuth(destination.requestAuth),
    });
    return { ...result, eventId };
  }

  async deleteDestination(destinationId: string): Promise<{ removed: true; hostPermissionRemoved: boolean }> {
    const destination = await this.requireDestination(destinationId);
    const hostPermission = normalizeWebhookEndpoint(destination.endpoint).hostPermission;
    await this.deps.unitOfWork.deleteDestination(destination, this.now());
    const remaining = await this.deps.destinations.list();
    const hostStillUsed = remaining.some((candidate) => (
      normalizeWebhookEndpoint(candidate.endpoint).hostPermission === hostPermission
    ));
    const hostPermissionRemoved = hostStillUsed
      ? false
      : await this.deps.removeHostPermission(hostPermission);
    return { removed: true, hostPermissionRemoved };
  }

  async sendRecording(destinationId: string, recordingId: string): Promise<IntegrationDelivery> {
    const destination = await this.requireDestination(destinationId);
    if (!destination.enabled) throw new Error('Integration destination is disabled');
    await this.assertDestinationPermission(destination);
    const current = await this.deps.streams.get(destination.id, recordingId);
    const externalRecordingId = current?.externalRecordingId ?? createIntegrationId('recording');
    const revision = current?.nextRevision ?? 1;
    const eventKind = current?.readyCreated ? 'recording.updated.v1' : 'recording.ready.v1';
    const eventId = createIntegrationId('event');
    const eventTime = this.now();
    const snapshot = await this.deps.snapshots.build(
      recordingId,
      destination.dataPolicy,
      {
        eventTypePrefix: this.deps.eventTypePrefix,
        eventKind,
        eventId,
        eventTime,
        producerId: destination.producerId,
        externalRecordingId,
        revision,
      },
      current?.speakerAliases,
    );
    assertIntegrationPayloadWithinLimit(snapshot, INTEGRATION_MAX_PAYLOAD_BYTES);
    const delivery = await this.planDelivery({
      destination,
      current,
      recordingId,
      externalRecordingId,
      revision,
      eventId,
      eventKind,
      eventTime,
      body: snapshot.body,
      totalBytes: snapshot.totalBytes,
      transcriptBytes: snapshot.transcriptBytes,
      speakerAliases: snapshot.speakerAliases,
    });
    return await this.attempt(delivery, destination, snapshot.body);
  }

  async listDeliveries(): Promise<IntegrationDelivery[]> {
    const rows = await this.deps.deliveries.list();
    return rows.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async planDelivery(input: {
    destination: IntegrationDestination;
    current?: IntegrationStream;
    recordingId: string;
    externalRecordingId: string;
    revision: number;
    eventId: string;
    eventKind: 'recording.ready.v1' | 'recording.updated.v1';
    eventTime: number;
    body: string;
    totalBytes: number;
    transcriptBytes: number;
    speakerAliases?: IntegrationSpeakerAlias[];
  }): Promise<IntegrationDelivery> {
    const createdAt = this.now();
    const delivery: IntegrationDelivery = {
      id: createIntegrationId('delivery'),
      destinationId: input.destination.id,
      recordingId: input.recordingId,
      externalRecordingId: input.externalRecordingId,
      eventId: input.eventId,
      eventType: input.eventKind,
      revision: input.revision,
      eventTime: input.eventTime,
      connectionVersion: input.destination.connectionVersion,
      state: 'pending',
      attemptCount: 0,
      bodyHash: await sha256Hex(input.body),
      totalBytes: input.totalBytes,
      transcriptBytes: input.transcriptBytes,
      createdAt,
      updatedAt: createdAt,
    };
    const stream: IntegrationStream = {
      destinationId: input.destination.id,
      recordingId: input.recordingId,
      externalRecordingId: input.externalRecordingId,
      nextRevision: input.revision + 1,
      readyCreated: true,
      everAttempted: true,
      ...(input.current?.lastPlannedProjectionHash
        ? { lastPlannedProjectionHash: input.current.lastPlannedProjectionHash }
        : {}),
      ...((input.speakerAliases?.length || input.current?.speakerAliases?.length)
        ? { speakerAliases: input.speakerAliases ?? input.current?.speakerAliases }
        : {}),
    };
    await this.deps.unitOfWork.planDelivery(delivery, stream);
    return delivery;
  }

  private async attempt(
    delivery: IntegrationDelivery,
    destination: IntegrationDestination,
    body: string,
  ): Promise<IntegrationDelivery> {
    if (!await this.deps.destinations.get(destination.id)) {
      return await this.cancelDeletedDestinationDelivery(delivery);
    }
    const delivering: IntegrationDelivery = {
      ...delivery,
      state: 'delivering',
      attemptCount: delivery.attemptCount + 1,
      updatedAt: this.now(),
    };
    await this.deps.deliveries.put(delivering);
    try {
      const result = await this.deps.transport.send({
        endpoint: destination.endpoint,
        eventId: delivery.eventId,
        body,
        signingSecret: await this.requireSecretValue(destination.signingSecretId),
        requestAuth: await this.resolveRequestAuth(destination.requestAuth),
      });
      if (!await this.deps.destinations.get(destination.id)) {
        return await this.cancelDeletedDestinationDelivery(delivering);
      }
      const final: IntegrationDelivery = {
        ...delivering,
        state: result.ok ? 'delivered' : classifyHttpFailure(result.status),
        lastStatus: result.status,
        lastErrorCode: result.ok ? undefined : `http-${result.status}`,
        updatedAt: this.now(),
      };
      await this.deps.deliveries.put(final);
      return final;
    } catch (error) {
      const final: IntegrationDelivery = {
        ...delivering,
        state: 'failed',
        lastErrorCode: error instanceof WebhookTransportError ? error.code : 'transport-error',
        updatedAt: this.now(),
      };
      await this.deps.deliveries.put(final);
      return final;
    }
  }

  private async cancelDeletedDestinationDelivery(
    delivery: IntegrationDelivery,
  ): Promise<IntegrationDelivery> {
    const canceled: IntegrationDelivery = {
      ...delivery,
      state: 'canceled',
      lastErrorCode: 'destination-deleted',
      updatedAt: this.now(),
    };
    delete canceled.nextAttemptAt;
    await this.deps.deliveries.put(canceled);
    return canceled;
  }

  private prepareRequestAuth(
    auth: CreateIntegrationDestinationInput['requestAuth'],
    now: number,
  ): { reference: IntegrationRequestAuth; secret?: IntegrationSecret } {
    if (auth.type === 'none') return { reference: { type: 'none' } };
    if (!auth.value) throw new Error('Integration request credential is required');
    const apiKeyHeader = auth.type === 'api-key'
      ? normalizeWebhookApiKeyHeader(auth.header)
      : undefined;
    const secretId = createIntegrationId('secret');
    const secret: IntegrationSecret = {
      id: secretId,
      kind: 'request-auth',
      value: auth.value,
      createdAt: now,
      updatedAt: now,
    };
    return {
      secret,
      reference: auth.type === 'bearer'
        ? { type: 'bearer', secretId }
        : { type: 'api-key', header: apiKeyHeader!, secretId },
    };
  }

  private async resolveRequestAuth(auth: IntegrationRequestAuth): Promise<ResolvedWebhookRequestAuth> {
    if (auth.type === 'none') return { type: 'none' };
    const value = await this.requireSecretValue(auth.secretId);
    return auth.type === 'bearer'
      ? { type: 'bearer', value }
      : { type: 'api-key', header: auth.header, value };
  }

  private async requireDestination(id: string): Promise<IntegrationDestination> {
    const destination = await this.deps.destinations.get(id);
    if (!destination) throw new Error('Integration destination does not exist');
    return destination;
  }

  private async requireSecretValue(id: string): Promise<string> {
    const secret = await this.deps.secrets.get(id);
    if (!secret) throw new Error('Integration credential is unavailable');
    return secret.value;
  }

  private async assertDestinationPermission(destination: IntegrationDestination): Promise<void> {
    await this.assertPermission(normalizeWebhookEndpoint(destination.endpoint).hostPermission);
  }

  private async assertPermission(pattern: string): Promise<void> {
    if (!await this.deps.containsHostPermission(pattern)) {
      throw new Error(`Host permission is required for ${pattern}`);
    }
  }
}

function classifyHttpFailure(status: number): IntegrationDelivery['state'] {
  if ((status >= 300 && status < 400) || [400, 401, 403, 410, 413].includes(status)) {
    return 'action-required';
  }
  return 'failed';
}
