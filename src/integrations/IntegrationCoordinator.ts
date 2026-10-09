import { createIntegrationId } from './ids';
import { buildIntegrationTestPayload } from './IntegrationTestEvent';
import type { IntegrationPlanResult } from './IntegrationEventPlanner';
import {
  parseCreateIntegrationDestinationInput,
  type CreateIntegrationDestinationInput,
  type CreatedIntegrationDestination,
  type IntegrationConnectionTestResult,
} from './management';
import type {
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationRequestAuth,
  IntegrationSecret,
} from './persistence';
import { createStandardWebhookSecret } from './webhook/StandardWebhookSigner';
import { normalizeWebhookEndpoint } from './webhook/WebhookEndpoint';
import { normalizeWebhookApiKeyHeader, type ResolvedWebhookRequestAuth } from './webhook/WebhookAuth';
import type { WebhookTransportResult } from './webhook/WebhookTransport';
import { ExternalMediaClient } from './media/ExternalMediaClient';
import type { ExternalMediaGrant } from './media/ExternalMediaClient';
import type { MediaCapability } from './media/MediaCapability';
import type { AuthorizedMediaRoute } from './RecordingRoutingService';

type CoordinatorDeps = {
  destinations: {
    get(id: string): Promise<IntegrationDestination | undefined>;
    list(): Promise<IntegrationDestination[]>;
  };
  secrets: {
    get(id: string): Promise<IntegrationSecret | undefined>;
  };
  deliveries: {
    list(): Promise<IntegrationDelivery[]>;
  };
  unitOfWork: {
    createDestination(destination: IntegrationDestination, secrets: IntegrationSecret[]): Promise<void>;
    configureMedia(destinationId: string, secret: IntegrationSecret, capability: MediaCapability, updatedAt: number): Promise<void>;
    setDestinationEnabled(destinationId: string, enabled: boolean, updatedAt: number): Promise<void>;
    deleteDestination(destination: IntegrationDestination, updatedAt: number): Promise<void>;
  };
  planner: {
    planManual(destination: IntegrationDestination, recordingId: string): Promise<IntegrationPlanResult>;
  };
  dispatcher: {
    dispatch(deliveryId: string, preparedBody?: string): Promise<IntegrationDelivery>;
  };
  transport: {
    send(input: {
      endpoint: string;
      eventId: string;
      body: string;
      signingSecret: string;
      requestAuth: ResolvedWebhookRequestAuth;
      discoverCapabilities?: boolean;
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
      discoverCapabilities: true,
    });
    return { ...result, eventId };
  }

  /** The receiver issues this token separately from the webhook signing secret. */
  async configureMedia(destinationId: string, bearer: string): Promise<void> {
    if (typeof bearer !== 'string' || !bearer.trim() || bearer.length > 4096 || /[\r\n]/.test(bearer)) {
      throw new Error('Invalid media bearer token');
    }
    await this.requireDestination(destinationId);
    const test = await this.testDestination(destinationId);
    if (!test.ok || !test.mediaCapability) throw new Error('Receiver did not advertise a valid media capability');
    const now = this.now();
    await this.deps.unitOfWork.configureMedia(destinationId, {
      id: createIntegrationId('secret'), kind: 'media-auth', value: bearer,
      createdAt: now, updatedAt: now,
    }, test.mediaCapability, now);
  }

  async setDestinationEnabled(destinationId: string, enabled: boolean): Promise<IntegrationDestination> {
    await this.requireDestination(destinationId);
    await this.deps.unitOfWork.setDestinationEnabled(destinationId, enabled, this.now());
    return await this.requireDestination(destinationId);
  }

  async mediaClient(destinationId: string, hasUploadHostPermission: (origin: string) => Promise<boolean>): Promise<ExternalMediaClient> {
    const destination = await this.requireDestination(destinationId);
    if (!destination.enabled || !destination.media) throw new Error('Media connection is unavailable');
    await this.assertDestinationPermission(destination);
    const secret = await this.deps.secrets.get(destination.media.secretId);
    if (!secret || secret.kind !== 'media-auth') throw new Error('Media credential is missing');
    return new ExternalMediaClient(
      destination.media.capability, destination.endpoint,
      async () => secret.value, fetch, hasUploadHostPermission,
    );
  }

  /**
   * Existing replicas remain playable while automation is disabled. The
   * credential and host permission are still required; disconnect removes both
   * the destination and its credential, so this path then fails closed.
   */
  async playbackMediaClient(
    destinationId: string,
    hasUploadHostPermission: (origin: string) => Promise<boolean>,
  ): Promise<ExternalMediaClient> {
    const destination = await this.requireDestination(destinationId);
    if (!destination.media) throw new Error('Media connection is unavailable');
    await this.assertDestinationPermission(destination);
    const secret = await this.deps.secrets.get(destination.media.secretId);
    if (!secret || secret.kind !== 'media-auth') throw new Error('Media credential is missing');
    return new ExternalMediaClient(
      destination.media.capability, destination.endpoint,
      async () => secret.value, fetch, hasUploadHostPermission,
    );
  }

  /**
   * Issues an ephemeral grant only for the exact receiver identity captured at
   * recording Start. Permission checks stay in background; the offscreen page
   * receives no generic secret lookup capability.
   */
  async mediaGrant(route: AuthorizedMediaRoute): Promise<ExternalMediaGrant> {
    const destination = await this.requireDestination(route.destinationId);
    if (!destination.enabled || !destination.media ||
        destination.connectionVersion !== route.connectionVersion ||
        destination.producerId !== route.receiver.producerId ||
        destination.endpoint !== route.receiver.endpoint ||
        destination.media.capability.apiBase !== route.receiver.apiBase ||
        destination.media.capability.upload.origins.length !== route.receiver.uploadOrigins.length ||
        !destination.media.capability.upload.origins.every((origin, index) =>
          origin === route.receiver.uploadOrigins[index])) {
      throw new Error('Media connection no longer matches recording authorization');
    }
    await this.assertDestinationPermission(destination);
    for (const origin of destination.media.capability.upload.origins) {
      if (!await this.deps.containsHostPermission(`${origin}/*`)) {
        throw new Error(`Host permission is required for ${origin}/*`);
      }
    }
    const secret = await this.deps.secrets.get(destination.media.secretId);
    if (!secret || secret.kind !== 'media-auth') throw new Error('Media credential is missing');
    return {
      destinationId: destination.id,
      connectionVersion: destination.connectionVersion,
      producerId: destination.producerId,
      endpoint: destination.endpoint,
      capability: destination.media.capability,
      bearer: secret.value,
    };
  }

  async deleteDestination(destinationId: string): Promise<{
    removed: true;
    hostPermissionRemoved: boolean;
    hostPermissionCleanup: 'removed' | 'retained-in-use' | 'failed';
  }> {
    const destination = await this.requireDestination(destinationId);
    const hostPermission = normalizeWebhookEndpoint(destination.endpoint).hostPermission;
    await this.deps.unitOfWork.deleteDestination(destination, this.now());
    try {
      const remaining = await this.deps.destinations.list();
      const hostStillUsed = remaining.some((candidate) => (
        normalizeWebhookEndpoint(candidate.endpoint).hostPermission === hostPermission
      ));
      if (hostStillUsed) {
        return {
          removed: true,
          hostPermissionRemoved: false,
          hostPermissionCleanup: 'retained-in-use',
        };
      }
      const hostPermissionRemoved = await this.deps.removeHostPermission(hostPermission);
      return {
        removed: true,
        hostPermissionRemoved,
        hostPermissionCleanup: hostPermissionRemoved ? 'removed' : 'failed',
      };
    } catch {
      return {
        removed: true,
        hostPermissionRemoved: false,
        hostPermissionCleanup: 'failed',
      };
    }
  }

  async sendRecording(destinationId: string, recordingId: string): Promise<IntegrationDelivery> {
    const destination = await this.requireDestination(destinationId);
    if (!destination.enabled) throw new Error('Integration destination is disabled');
    await this.assertDestinationPermission(destination);
    const planned = await this.deps.planner.planManual(destination, recordingId);
    if (planned.kind !== 'planned') throw new Error('Manual integration send was not planned');
    return await this.deps.dispatcher.dispatch(planned.delivery.id, planned.body);
  }

  async listDeliveries(): Promise<IntegrationDelivery[]> {
    const rows = await this.deps.deliveries.list();
    return rows.sort((left, right) => right.updatedAt - left.updatedAt);
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
