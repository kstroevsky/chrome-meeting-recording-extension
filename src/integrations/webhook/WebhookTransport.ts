import { signStandardWebhook } from './StandardWebhookSigner';
import { applyWebhookRequestAuth, type ResolvedWebhookRequestAuth } from './WebhookAuth';
import { clampRetryAfterMs } from '../IntegrationRetryPolicy';
import { parseMediaCapability, type MediaCapability } from '../media/MediaCapability';

export type WebhookTransportResult = {
  ok: boolean;
  status: number;
  /** Normalized relative delay; arbitrary receiver headers never cross this seam. */
  retryAfterMs?: number;
  /** Only populated for a signed, successful connection-test response. */
  mediaCapability?: MediaCapability;
  capabilityError?: 'invalid-response';
};

export class WebhookTransportError extends Error {
  constructor(readonly code: 'network-error' | 'timeout', cause?: unknown) {
    super(code === 'timeout' ? 'Webhook request timed out' : 'Webhook request failed');
    this.name = 'WebhookTransportError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class WebhookTransport {
  constructor(private readonly deps: {
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  } = {}) {}

  async send(input: {
    endpoint: string;
    eventId: string;
    body: string;
    signingSecret: string;
    requestAuth: ResolvedWebhookRequestAuth;
    discoverCapabilities?: boolean;
  }): Promise<WebhookTransportResult> {
    const timestamp = Math.floor((this.deps.now?.() ?? Date.now()) / 1_000);
    const headers = new Headers({
      'content-type': 'application/cloudevents+json',
      'webhook-id': input.eventId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': await signStandardWebhook({
        secret: input.signingSecret,
        eventId: input.eventId,
        timestamp,
        body: input.body,
      }),
    });
    applyWebhookRequestAuth(headers, input.requestAuth);

    const controller = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.deps.fetch ?? fetch)(input.endpoint, {
        method: 'POST',
        headers,
        body: input.body,
        signal: controller.signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null, this.deps.now?.() ?? Date.now());
      let capability: Pick<WebhookTransportResult, 'mediaCapability' | 'capabilityError'> = {};
      if (input.discoverCapabilities && response.status === 200) {
        const contentType = response.headers?.get?.('content-type') ?? '';
        if (/^application\/json\s*(?:;|$)/i.test(contentType)) {
          try {
            const json = JSON.parse(await readBoundedResponse(response));
            const mediaCapability = parseMediaCapability(json, input.endpoint);
            capability = mediaCapability ? { mediaCapability } : { capabilityError: 'invalid-response' };
          } catch {
            capability = { capabilityError: 'invalid-response' };
          }
        } else {
          capability = { capabilityError: 'invalid-response' };
        }
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
        ...capability,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new WebhookTransportError('timeout', error);
      throw new WebhookTransportError('network-error', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Cap receiver-controlled capability JSON at 16 KiB even with chunked encoding. */
async function readBoundedResponse(response: Response): Promise<string> {
  const limit = 16 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Capability response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Capability response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return clampRetryAfterMs(Number(trimmed) * 1_000);
  }

  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return clampRetryAfterMs(Math.max(0, date - now));
}
