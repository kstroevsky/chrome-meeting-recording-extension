import type { IntegrationDataPolicy, IntegrationEventKind } from './contracts';
import { normalizeIntegrationDataPolicy } from './policy';

export type IntegrationRoutingDefault = 'manual' | 'auto' | 'review';
export type IntegrationRequestAuth =
  | { type: 'none' }
  | { type: 'bearer'; secretId: string }
  | { type: 'api-key'; header: string; secretId: string };

export type IntegrationDestination = {
  id: string;
  producerId: string;
  name: string;
  type: 'webhook';
  enabled: boolean;
  endpoint: string;
  routingDefault: IntegrationRoutingDefault;
  dataPolicy: IntegrationDataPolicy;
  requestAuth: IntegrationRequestAuth;
  signingSecretId: string;
  connectionVersion: number;
  createdAt: number;
  updatedAt: number;
};

/** Plaintext is intentionally accessible only through the secret repository. */
export type IntegrationSecret = {
  id: string;
  kind: 'signing' | 'request-auth';
  value: string;
  createdAt: number;
  updatedAt: number;
};

export type RecordingIntegrationIntentDestination = {
  destinationId: string;
  mode: 'auto' | 'review';
  state: 'selected' | 'skipped' | 'needs-review' | 'approved';
  allowedPolicy: IntegrationDataPolicy;
  connectionVersion: number;
  approvedPolicyHash?: string;
};

export type RecordingIntegrationIntent = {
  recordingId: string;
  destinations: RecordingIntegrationIntentDestination[];
};

export type IntegrationStream = {
  destinationId: string;
  recordingId: string;
  externalRecordingId: string;
  nextRevision: number;
  readyCreated: boolean;
  everAttempted: boolean;
  lastPlannedProjectionHash?: string;
};

export type IntegrationDeliveryState =
  | 'pending'
  | 'delivering'
  | 'retrying'
  | 'delivered'
  | 'failed'
  | 'superseded'
  | 'canceled'
  | 'action-required';

export type IntegrationDelivery = {
  id: string;
  destinationId: string;
  recordingId: string;
  externalRecordingId: string;
  eventId: string;
  eventType: IntegrationEventKind;
  revision: number;
  eventTime: number;
  connectionVersion: number;
  state: IntegrationDeliveryState;
  attemptCount: number;
  nextAttemptAt?: number;
  bodyHash?: string;
  lastStatus?: number;
  lastErrorCode?: string;
  createdAt: number;
  updatedAt: number;
};

export function normalizeIntegrationDestination(value: unknown): IntegrationDestination | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const producerId = text(value.producerId);
  const name = text(value.name);
  const endpoint = text(value.endpoint);
  const signingSecretId = text(value.signingSecretId);
  const dataPolicy = normalizeIntegrationDataPolicy(value.dataPolicy);
  const requestAuth = normalizeRequestAuth(value.requestAuth);
  const connectionVersion = positiveInteger(value.connectionVersion);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (!id || !producerId || !name || !endpoint || !signingSecretId || !dataPolicy || !requestAuth) return undefined;
  if (value.type !== 'webhook' || typeof value.enabled !== 'boolean') return undefined;
  if (!isRoutingDefault(value.routingDefault) || connectionVersion == null || createdAt == null || updatedAt == null) {
    return undefined;
  }
  return {
    id,
    producerId,
    name,
    type: 'webhook',
    enabled: value.enabled,
    endpoint,
    routingDefault: value.routingDefault,
    dataPolicy,
    requestAuth,
    signingSecretId,
    connectionVersion,
    createdAt,
    updatedAt,
  };
}

export function normalizeIntegrationSecret(value: unknown): IntegrationSecret | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const secretValue = text(value.value, false);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (!id || !secretValue || createdAt == null || updatedAt == null) return undefined;
  if (value.kind !== 'signing' && value.kind !== 'request-auth') return undefined;
  return { id, kind: value.kind, value: secretValue, createdAt, updatedAt };
}

export function normalizeRecordingIntegrationIntent(value: unknown): RecordingIntegrationIntent | undefined {
  if (!isRecord(value) || !Array.isArray(value.destinations)) return undefined;
  const recordingId = text(value.recordingId);
  if (!recordingId) return undefined;
  const destinations = value.destinations.map(normalizeIntentDestination);
  if (destinations.some((destination) => destination == null)) return undefined;
  const valid = destinations as RecordingIntegrationIntentDestination[];
  if (new Set(valid.map((destination) => destination.destinationId)).size !== valid.length) return undefined;
  return { recordingId, destinations: valid };
}

export function normalizeIntegrationStream(value: unknown): IntegrationStream | undefined {
  if (!isRecord(value)) return undefined;
  const destinationId = text(value.destinationId);
  const recordingId = text(value.recordingId);
  const externalRecordingId = text(value.externalRecordingId);
  const nextRevision = positiveInteger(value.nextRevision);
  const lastPlannedProjectionHash = optionalText(value.lastPlannedProjectionHash);
  if (!destinationId || !recordingId || !externalRecordingId || nextRevision == null) return undefined;
  if (typeof value.readyCreated !== 'boolean' || typeof value.everAttempted !== 'boolean') return undefined;
  return {
    destinationId,
    recordingId,
    externalRecordingId,
    nextRevision,
    readyCreated: value.readyCreated,
    everAttempted: value.everAttempted,
    ...(lastPlannedProjectionHash ? { lastPlannedProjectionHash } : {}),
  };
}

export function normalizeIntegrationDelivery(value: unknown): IntegrationDelivery | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const destinationId = text(value.destinationId);
  const recordingId = text(value.recordingId);
  const externalRecordingId = text(value.externalRecordingId);
  const eventId = text(value.eventId);
  const revision = positiveInteger(value.revision);
  const eventTime = timestamp(value.eventTime);
  const connectionVersion = positiveInteger(value.connectionVersion);
  const attemptCount = nonNegativeInteger(value.attemptCount);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (!id || !destinationId || !recordingId || !externalRecordingId || !eventId) return undefined;
  if (!isEventKind(value.eventType) || !isDeliveryState(value.state)) return undefined;
  if (revision == null || eventTime == null || connectionVersion == null || attemptCount == null) return undefined;
  if (createdAt == null || updatedAt == null) return undefined;
  const nextAttemptAt = optionalTimestamp(value.nextAttemptAt);
  const lastStatus = optionalHttpStatus(value.lastStatus);
  const bodyHash = optionalText(value.bodyHash);
  const lastErrorCode = optionalText(value.lastErrorCode);
  if (value.nextAttemptAt != null && nextAttemptAt == null) return undefined;
  if (value.lastStatus != null && lastStatus == null) return undefined;
  if (bodyHash && !/^[a-f0-9]{64}$/i.test(bodyHash)) return undefined;
  return {
    id,
    destinationId,
    recordingId,
    externalRecordingId,
    eventId,
    eventType: value.eventType,
    revision,
    eventTime,
    connectionVersion,
    state: value.state,
    attemptCount,
    ...(nextAttemptAt != null ? { nextAttemptAt } : {}),
    ...(bodyHash ? { bodyHash: bodyHash.toLowerCase() } : {}),
    ...(lastStatus != null ? { lastStatus } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeRequestAuth(value: unknown): IntegrationRequestAuth | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'none') return { type: 'none' };
  const secretId = text(value.secretId);
  if (!secretId) return undefined;
  if (value.type === 'bearer') return { type: 'bearer', secretId };
  if (value.type !== 'api-key') return undefined;
  const header = text(value.header);
  return header ? { type: 'api-key', header, secretId } : undefined;
}

function normalizeIntentDestination(value: unknown): RecordingIntegrationIntentDestination | undefined {
  if (!isRecord(value)) return undefined;
  const destinationId = text(value.destinationId);
  const allowedPolicy = normalizeIntegrationDataPolicy(value.allowedPolicy);
  const connectionVersion = positiveInteger(value.connectionVersion);
  const approvedPolicyHash = optionalText(value.approvedPolicyHash);
  if (!destinationId || !allowedPolicy || connectionVersion == null) return undefined;
  if ((value.mode !== 'auto' && value.mode !== 'review') || !isIntentState(value.state)) return undefined;
  return {
    destinationId,
    mode: value.mode,
    state: value.state,
    allowedPolicy,
    connectionVersion,
    ...(approvedPolicyHash ? { approvedPolicyHash } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, trim = true): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = trim ? value.trim() : value;
  return result ? result : undefined;
}

function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : text(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalTimestamp(value: unknown): number | undefined {
  return value == null ? undefined : timestamp(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalHttpStatus(value: unknown): number | undefined {
  return value == null
    ? undefined
    : typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined;
}

function isRoutingDefault(value: unknown): value is IntegrationRoutingDefault {
  return value === 'manual' || value === 'auto' || value === 'review';
}

function isIntentState(value: unknown): value is RecordingIntegrationIntentDestination['state'] {
  return value === 'selected' || value === 'skipped' || value === 'needs-review' || value === 'approved';
}

function isEventKind(value: unknown): value is IntegrationEventKind {
  return value === 'recording.ready.v1'
    || value === 'recording.updated.v1'
    || value === 'recording.deleted.v1'
    || value === 'integration.test.v1';
}

function isDeliveryState(value: unknown): value is IntegrationDeliveryState {
  return value === 'pending'
    || value === 'delivering'
    || value === 'retrying'
    || value === 'delivered'
    || value === 'failed'
    || value === 'superseded'
    || value === 'canceled'
    || value === 'action-required';
}
