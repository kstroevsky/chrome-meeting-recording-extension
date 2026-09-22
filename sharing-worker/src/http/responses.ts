export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
