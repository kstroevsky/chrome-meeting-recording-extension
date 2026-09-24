import { signStandardWebhook } from './StandardWebhookSigner';
import { applyWebhookRequestAuth, type ResolvedWebhookRequestAuth } from './WebhookAuth';
import { clampRetryAfterMs } from '../IntegrationRetryPolicy';

export type WebhookTransportResult = {
  ok: boolean;
  status: number;
  /** Normalized relative delay; arbitrary receiver headers never cross this seam. */
  retryAfterMs?: number;
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
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
      };
    } catch (error) {
      if (controller.signal.aborted) throw new WebhookTransportError('timeout', error);
      throw new WebhookTransportError('network-error', error);
    } finally {
      clearTimeout(timer);
    }
  }
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
