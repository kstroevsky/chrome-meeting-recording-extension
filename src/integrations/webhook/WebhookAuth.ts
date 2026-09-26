export type ResolvedWebhookRequestAuth =
  | { type: 'none' }
  | { type: 'bearer'; value: string }
  | { type: 'api-key'; header: string; value: string };

const RESERVED_HEADERS = new Set([
  'content-type',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
]);

export function normalizeWebhookApiKeyHeader(value: string): string {
  const name = value.trim();
  if (!name) throw new Error('Webhook API-key header is required');
  if (RESERVED_HEADERS.has(name.toLowerCase())) {
    throw new Error('Webhook API-key header conflicts with protocol headers');
  }
  try {
    new Headers().set(name, 'validation-value');
  } catch {
    throw new Error('Webhook API-key header is invalid');
  }
  return name;
}

export function applyWebhookRequestAuth(headers: Headers, auth: ResolvedWebhookRequestAuth): void {
  if (auth.type === 'none') return;
  if (!auth.value) throw new Error('Webhook request credential is empty');
  if (auth.type === 'bearer') {
    headers.set('authorization', `Bearer ${auth.value}`);
    return;
  }
  headers.set(normalizeWebhookApiKeyHeader(auth.header), auth.value);
}
