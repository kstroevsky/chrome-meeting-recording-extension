import type { MediaCapability } from './MediaCapability';

export type MediaArtifactRole = 'tab-recording' | 'microphone-recording' | 'self-video';
export type UploadCreate = {
  clientTransferId: string;
  recordingId: string;
  artifact: { role: MediaArtifactRole; filename: string; mimeType: string; bytes: number };
};
export type MediaPart = { partNumber: number; etag: string };
export type UploadResponse =
  | { state: 'ready'; artifactId: string }
  | { state: 'uploading'; artifactId: string; uploadId: string; partSize: number; maxConcurrency: number; strategy: 'multipart-put-v1' };
export type UploadStatus = { state: 'ready'; artifactId: string } |
  { state: 'uploading'; artifactId: string; uploadedParts: MediaPart[] };

const MAX_RESPONSE_BYTES = 64 * 1024;
const ID = /^(?:media|upload)_[0-9a-f-]{36}$/i;

export class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super(`Media service returned HTTP ${status}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid media response');
  return value as Record<string, unknown>;
}

function mediaId(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !ID.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new Error('Invalid media identifier');
  }
  return value;
}

/** Revalidate persisted capability data at its actual point of use. */
function checkCapability(capability: MediaCapability, endpoint: string): string {
  const origin = new URL(endpoint);
  const base = new URL(capability.apiBase);
  if (origin.protocol !== 'https:' || base.protocol !== 'https:' || base.origin !== origin.origin ||
      base.username || base.password || base.search || base.hash ||
      capability.version !== 1 || capability.upload.strategy !== 'multipart-put-v1' ||
      capability.playback.strategy !== 'refreshable-url-v1' || !capability.upload.origins.length ||
      capability.upload.origins.length > 8 || capability.upload.origins.some((raw) => {
        try {
          const url = new URL(raw);
          return raw !== url.origin || url.protocol !== 'https:' || url.hostname.includes('*');
        } catch { return true; }
      })) throw new Error('Invalid media capability');
  return base.href.replace(/\/$/, '');
}

async function jsonBounded(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Media response too large');
  if (!response.body) throw new Error('Empty media response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('Media response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const joined = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.byteLength; }
  return object(JSON.parse(new TextDecoder().decode(joined)));
}

function parseUploadResponse(value: Record<string, unknown>): UploadResponse {
  const artifactId = mediaId(value.artifactId, 'media');
  if (value.state === 'ready') return { state: 'ready', artifactId };
  if (value.state !== 'uploading' || value.strategy !== 'multipart-put-v1' ||
      !Number.isSafeInteger(value.partSize) || (value.partSize as number) < 5 * 1024 * 1024 ||
      (value.partSize as number) > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(value.maxConcurrency) || (value.maxConcurrency as number) < 1 ||
      (value.maxConcurrency as number) > 3) throw new Error('Unsupported media upload parameters');
  return {
    state: 'uploading', artifactId, uploadId: mediaId(value.uploadId, 'upload'),
    strategy: 'multipart-put-v1', partSize: value.partSize as number,
    maxConcurrency: value.maxConcurrency as number,
  };
}

/** HTTPS-only control plane; the credential is never used for the storage PUT. */
export class ExternalMediaClient {
  private readonly base: string;

  constructor(
    readonly capability: MediaCapability,
    webhookEndpoint: string,
    private readonly getBearer: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly hasUploadHostPermission: (origin: string) => Promise<boolean> = async () => false,
  ) {
    this.base = checkCapability(capability, webhookEndpoint);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) {
    const token = await this.getBearer();
    if (!token || /[\r\n]/.test(token)) throw new Error('Invalid media credential');
    const response = await this.fetcher(`${this.base}/v1/${path}`, {
      method, redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
    });
    if (!response.ok) throw new MediaHttpError(response.status);
    return jsonBounded(response);
  }

  async create(input: UploadCreate, signal?: AbortSignal): Promise<UploadResponse> {
    return parseUploadResponse(await this.request('POST', 'uploads', input, signal));
  }

  async status(uploadId: string, signal?: AbortSignal): Promise<UploadStatus> {
    mediaId(uploadId, 'upload');
    const response = await this.request('GET', `uploads/${uploadId}`, undefined, signal);
    const artifactId = mediaId(response.artifactId, 'media');
    if (response.state === 'ready') return { state: 'ready', artifactId };
    if (response.state !== 'uploading' || !Array.isArray(response.uploadedParts)) throw new Error('Invalid media upload status');
    const uploadedParts: MediaPart[] = [];
    for (const item of response.uploadedParts) {
      const part = object(item);
      if (!Number.isSafeInteger(part.partNumber) || (part.partNumber as number) < 1 ||
          (part.partNumber as number) > 10000 || typeof part.etag !== 'string' || !part.etag ||
          uploadedParts.some((entry) => entry.partNumber === part.partNumber)) throw new Error('Invalid media parts manifest');
      uploadedParts.push({ partNumber: part.partNumber as number, etag: part.etag });
    }
    return { state: 'uploading', artifactId, uploadedParts };
  }

  async uploadPart(uploadId: string, partNumber: number, body: Blob, signal?: AbortSignal): Promise<string> {
    mediaId(uploadId, 'upload');
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('Invalid part');
    for (let refresh = 0; refresh < 3; refresh++) {
      const signed = await this.request('POST', `uploads/${uploadId}/parts/${partNumber}`, undefined, signal);
      if (signed.method !== 'PUT' || typeof signed.url !== 'string') throw new Error('Invalid signed media URL');
      const url = new URL(signed.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
          !this.capability.upload.origins.includes(url.origin) ||
          !await this.hasUploadHostPermission(url.origin)) throw new Error('Untrusted media upload URL');
      const headers = object(signed.headers);
      if (Object.entries(headers).some(([key, value]) =>
        typeof value !== 'string' || !/^[a-z0-9-]+$/i.test(key) ||
        /^(authorization|cookie|proxy-authorization|host|content-length|set-cookie)$/i.test(key) ||
        /[\r\n]/.test(value))) throw new Error('Invalid signed media headers');
      let response: Response;
      try {
        response = await this.fetcher(url.href, {
          method: 'PUT', headers: headers as Record<string, string>, body,
          redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
        });
      } catch (error) {
        // A storage error can be reported as a network failure when a signed URL
        // expires without CORS headers. Obtain a fresh, independently checked URL.
        if (error instanceof TypeError && !signal?.aborted && refresh < 2) continue;
        throw error;
      }
      if (response.status === 403) continue; // Presigned URL expired: sign again.
      if (!response.ok) throw new MediaHttpError(response.status);
      const etag = response.headers.get('etag');
      if (!etag || /[\r\n]/.test(etag)) throw new Error('Storage did not expose a valid ETag');
      return etag;
    }
    throw new MediaHttpError(403);
  }

  async complete(uploadId: string, parts: MediaPart[], signal?: AbortSignal): Promise<{ state: 'ready'; artifactId: string }> {
    mediaId(uploadId, 'upload');
    const response = await this.request('POST', `uploads/${uploadId}/complete`, { parts }, signal);
    if (response.state !== 'ready') throw new Error('Media completion was not verified');
    return { state: 'ready', artifactId: mediaId(response.artifactId, 'media') };
  }

  async playback(artifactId: string, signal?: AbortSignal): Promise<{ url: string; expiresAt: string }> {
    mediaId(artifactId, 'media');
    const response = await this.request('POST', `artifacts/${artifactId}/playback`, undefined, signal);
    if (typeof response.url !== 'string' || typeof response.expiresAt !== 'string') throw new Error('Invalid media playback response');
    const url = new URL(response.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        !Number.isFinite(Date.parse(response.expiresAt))) throw new Error('Untrusted media playback URL');
    return { url: url.href, expiresAt: response.expiresAt };
  }
}
