import type { IntegrationDataPolicy } from './contracts';
import type { IntegrationDestination, IntegrationRoutingDefault } from './persistence';
import { normalizeIntegrationDataPolicy } from './policy';
import { normalizeWebhookApiKeyHeader } from './webhook/WebhookAuth';
import { normalizeWebhookEndpoint } from './webhook/WebhookEndpoint';

export type IntegrationRequestAuthDraft =
  | { type: 'none' }
  | { type: 'bearer'; value: string }
  | { type: 'api-key'; header: string; value: string };

export type CreateIntegrationDestinationInput = {
  name: string;
  endpoint: string;
  routingDefault: IntegrationRoutingDefault;
  dataPolicy: IntegrationDataPolicy;
  requestAuth: IntegrationRequestAuthDraft;
};

export type CreatedIntegrationDestination = {
  destination: IntegrationDestination;
  /** One-time display value. Normal list/read operations never return it. */
  signingSecret: string;
};

export type IntegrationConnectionTestResult = {
  ok: boolean;
  status: number;
  eventId: string;
};

/** Normalizes the untrusted CREATE_INTEGRATION payload before any credential write. */
export function normalizeCreateIntegrationDestinationInput(
  value: unknown,
): CreateIntegrationDestinationInput | undefined {
  try {
    return parseCreateIntegrationDestinationInput(value);
  } catch {
    return undefined;
  }
}

export function parseCreateIntegrationDestinationInput(
  value: unknown,
): CreateIntegrationDestinationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid integration destination input');
  }
  const input = value as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new Error('Integration name is required');
  if (typeof input.endpoint !== 'string') throw new Error('Integration HTTPS endpoint is required');
  if (input.routingDefault !== 'manual' && input.routingDefault !== 'auto' && input.routingDefault !== 'review') {
    throw new Error('Invalid integration routing mode');
  }
  const dataPolicy = normalizeIntegrationDataPolicy(input.dataPolicy);
  if (!dataPolicy) throw new Error('Invalid integration data policy');
  if (!dataPolicy.metadata) throw new Error('Integration metadata export is required for recording snapshots');
  const requestAuth = parseRequestAuthDraft(input.requestAuth);
  const endpoint = normalizeWebhookEndpoint(input.endpoint).endpoint;
  return {
    name,
    endpoint,
    routingDefault: input.routingDefault,
    dataPolicy,
    requestAuth,
  };
}

function parseRequestAuthDraft(value: unknown): IntegrationRequestAuthDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid integration request authentication');
  }
  const auth = value as Record<string, unknown>;
  if (auth.type === 'none') return { type: 'none' };
  if (auth.type === 'bearer') {
    if (typeof auth.value !== 'string' || !auth.value) {
      throw new Error('Integration request credential is required');
    }
    return { type: 'bearer', value: auth.value };
  }
  if (auth.type !== 'api-key' || typeof auth.header !== 'string' || typeof auth.value !== 'string' || !auth.value) {
    throw new Error('Invalid integration API-key authentication');
  }
  return {
    type: 'api-key',
    header: normalizeWebhookApiKeyHeader(auth.header),
    value: auth.value,
  };
}
