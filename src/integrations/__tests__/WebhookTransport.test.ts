import { createHmac } from 'crypto';
import { buildIntegrationTestPayload } from '../IntegrationTestEvent';
import { normalizeWebhookEndpoint } from '../webhook/WebhookEndpoint';
import { createStandardWebhookSecret, signStandardWebhook } from '../webhook/StandardWebhookSigner';
import { WebhookTransport, WebhookTransportError } from '../webhook/WebhookTransport';

function fixedSecret(): string {
  return `whsec_${Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index)).toString('base64')}`;
}

describe('webhook transport', () => {
  it('normalizes only HTTPS endpoints and derives exact host permission', () => {
    expect(normalizeWebhookEndpoint('https://hooks.example.test:8443/events?id=1')).toEqual({
      endpoint: 'https://hooks.example.test:8443/events?id=1',
      hostPermission: 'https://hooks.example.test:8443/*',
    });
    expect(() => normalizeWebhookEndpoint('http://localhost:8799/events')).toThrow('must use HTTPS');
    expect(() => normalizeWebhookEndpoint('https://user:pass@example.test/hook')).toThrow('URL credentials');
    expect(() => normalizeWebhookEndpoint('https://example.test/hook#secret')).toThrow('fragment');
  });

  it('creates Standard Webhooks compatible 32-byte secrets and signatures', async () => {
    const generated = createStandardWebhookSecret();
    expect(generated).toMatch(/^whsec_/);
    expect(Buffer.from(generated.slice('whsec_'.length), 'base64')).toHaveLength(32);

    const secret = fixedSecret();
    const body = '{"exact":true}';
    const signature = await signStandardWebhook({
      secret,
      eventId: 'evt_1',
      timestamp: 1_700_000_000,
      body,
    });
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`evt_1.1700000000.${body}`)
      .digest('base64');
    expect(signature).toBe(`v1,${expected}`);
  });

  it('posts the exact body with protocol headers, auth, and redirects disabled', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init };
      return { status: 204 } as Response;
    });
    const transport = new WebhookTransport({
      fetch: fetcher as typeof fetch,
      now: () => 1_700_000_000_000,
      timeoutMs: 5_000,
    });
    const body = buildIntegrationTestPayload({
      eventTypePrefix: 'dev.workers.kstroevsky.meeting-recorder',
      eventId: 'evt_test',
      eventTime: 1_700_000_000_000,
      producerId: 'producer_1',
    });

    await expect(transport.send({
      endpoint: 'https://hooks.example.test/events',
      eventId: 'evt_test',
      body,
      signingSecret: fixedSecret(),
      requestAuth: { type: 'api-key', header: 'x-api-key', value: 'request-secret' },
    })).resolves.toEqual({ ok: true, status: 204 });

    expect(captured).toBeDefined();
    const { input: url, init } = captured!;
    expect(url).toBe('https://hooks.example.test/events');
    expect(init).toBeDefined();
    const request = init!;
    expect(request.body).toBe(body);
    expect(request.redirect).toBe('manual');
    expect(request.credentials).toBe('omit');
    const headers = request.headers as Headers;
    expect(headers.get('content-type')).toBe('application/cloudevents+json');
    expect(headers.get('webhook-id')).toBe('evt_test');
    expect(headers.get('webhook-timestamp')).toBe('1700000000');
    expect(headers.get('webhook-signature')).toMatch(/^v1,/);
    expect(headers.get('x-api-key')).toBe('request-secret');
  });

  it('classifies an aborted fetch as a timeout', async () => {
    const fetcher = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const transport = new WebhookTransport({ fetch: fetcher as typeof fetch, timeoutMs: 1 });
    const error = await transport.send({
      endpoint: 'https://hooks.example.test/events',
      eventId: 'evt_timeout',
      body: '{}',
      signingSecret: fixedSecret(),
      requestAuth: { type: 'none' },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WebhookTransportError);
    expect(error.code).toBe('timeout');
  });
});
