/**
 * @file offscreen/drive/request.ts
 *
 * Small helpers for Drive requests that need token reuse and a single auth retry.
 */

import { isE2EMockDriveBuild } from '../../shared/build';

export type TokenProvider = (options?: { refresh?: boolean }) => Promise<string>;

type E2EDriveFetchResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
};

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    normalized[name] = value;
  });
  return normalized;
}

export async function driveFetch(
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> {
  const mockDriveEnabled = typeof __E2E_MOCK_DRIVE_BUILD__ !== 'undefined'
    ? __E2E_MOCK_DRIVE_BUILD__
    : isE2EMockDriveBuild();
  if (!mockDriveEnabled) return await fetch(input, init);

  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = init.method ?? (isRequest ? input.method : 'GET');
  const headers = normalizeHeaders(
    init.headers ?? (isRequest ? input.headers : undefined)
  );
  const body = typeof init.body === 'string' ? init.body : undefined;
  const response = await chrome.runtime.sendMessage({
    type: 'E2E_DRIVE_FETCH',
    url,
    method,
    headers,
    body,
  }) as E2EDriveFetchResponse;
  if (!response?.ok || response.status == null) {
    throw new TypeError(response?.error ?? 'E2E Drive fetch bridge failed');
  }
  return new Response(response.body ?? '', {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Wraps a token provider with in-memory per-upload caching.
 *
 * This avoids calling chrome.identity.getAuthToken for every single upload
 * chunk while still allowing one forced refresh when Google responds with
 * 401/403.
 */
export function createCachedTokenProvider(getToken: TokenProvider): TokenProvider {
  let cachedToken: string | null = null;
  let pendingToken: Promise<string> | null = null;
  let generation = 0;

  const loadToken = async (options?: { refresh?: boolean }, requestGeneration = generation) => {
    if (!pendingToken) {
      const tokenPromise = getToken(options)
        .then((token) => {
          if (requestGeneration === generation) {
            cachedToken = token;
          }
          return token;
        })
        .finally(() => {
          if (pendingToken === tokenPromise) {
            pendingToken = null;
          }
        });
      pendingToken = tokenPromise;
    }
    return await pendingToken;
  };

  return async (options?: { refresh?: boolean }) => {
    if (options?.refresh) {
      generation += 1;
      cachedToken = null;
      pendingToken = null;
      return await loadToken({ refresh: true }, generation);
    }

    if (cachedToken) return cachedToken;
    return await loadToken(undefined, generation);
  };
}

/**
 * Runs a request with an OAuth token and retries once with a refreshed token
 * for auth-related statuses.
 */
export async function fetchWithAuthRetry(
  getToken: TokenProvider,
  request: (token: string) => Promise<Response>
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 0 ? undefined : { refresh: true });
    const res = await request(token);
    last = res;
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    return res;
  }
  return last!;
}
