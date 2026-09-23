const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured limit');
    this.name = 'PayloadTooLargeError';
  }
}

export async function readJson(request: Request, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<unknown> {
  try {
    const bytes = await readBodyBytes(request, maxBytes);
    if (bytes.byteLength === 0) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    return null;
  }
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength != null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export function integerField(value: unknown, field: string): number | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : null;
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', headers.get('cache-control') ?? 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('referrer-policy', headers.get('referrer-policy') ?? 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
