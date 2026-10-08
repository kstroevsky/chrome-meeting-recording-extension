/**
 * @file offscreen/drive/request.ts
 *
 * Small helpers for Drive requests that need token reuse and a single auth retry.
 */

import { sendRuntimeMessage } from '../../platform/chrome/runtime';
import { isE2EMockDriveBuild } from '../../shared/build';
import { DRIVE_REQUEST_TIMEOUT_MS } from './constants';

export type TokenProvider = (options?: { refresh?: boolean }) => Promise<string>;

type E2EDriveFetchResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  error?: string;
};

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    normalized[name] = value;
  });
  return normalized;
}

async function encodeE2EBody(body: BodyInit | null | undefined): Promise<{
  body?: string;
  bodyBase64?: string;
}> {
  if (body == null) return {};
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };

  let bytes: Uint8Array | null = null;
  if (body instanceof Blob) bytes = await blobBytes(body);
  else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (!bytes) throw new TypeError('E2E Drive bridge cannot serialize this request body');

  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { bodyBase64: btoa(binary) };
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  const modern = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modern.arrayBuffer === 'function') {
    return new Uint8Array(await modern.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new TypeError('Could not read Drive request body'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
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
  const encodedBody = await encodeE2EBody(init.body);
  const response = await sendRuntimeMessage<E2EDriveFetchResponse>({
    type: 'E2E_DRIVE_FETCH',
    url,
    method,
    headers,
    ...encodedBody,
  });
  if (!response?.ok || response.status == null) {
    throw new TypeError(response?.error ?? 'E2E Drive fetch bridge failed');
  }
  const responseBody = response.bodyBase64 != null
    ? decodeBase64Bytes(response.bodyBase64)
    : response.body ?? '';
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Wraps any Drive HTTP request with a hard timeout and an optional job-cancel signal. */
export async function fetchWithTimeout(url: string, init: RequestInit, cancelSignal?: AbortSignal): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), DRIVE_REQUEST_TIMEOUT_MS);
  const onCancel = () => ac.abort();
  cancelSignal?.addEventListener('abort', onCancel, { once: true });
  if (cancelSignal?.aborted) ac.abort();
  try {
    return await driveFetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timeout);
    cancelSignal?.removeEventListener('abort', onCancel);
  }
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
