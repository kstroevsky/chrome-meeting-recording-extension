/**
 * @file sharing/ShareServiceClient.ts
 *
 * HTTP boundary between the extension and the sharing service. The extension
 * owns the public ids and sends only the sanitized published manifest; media
 * bytes travel through resumable upload sessions keyed by opaque upload ids.
 *
 * The paths in this file are the service contract for the backend implementation:
 *
 *   PUT    /api/shares/:shareId
 *   POST   /api/shares/:shareId/recordings/:recordingId/tracks/:trackId/uploads
 *   PUT    /api/share-uploads/:uploadId/chunks/:offset
 *   POST   /api/share-uploads/:uploadId/complete
 *   POST   /api/shares/:shareId/finalize
 *   POST   /api/shares/:shareId/revoke
 *   DELETE /api/shares/:shareId
 *
 * A chunk's offset is part of its URL and Content-Range, so replaying a request
 * after a lost response is naturally idempotent for the backend.
 */

import type { PublishedPlaybackManifest } from '../shared/sharing';
import type { SharePublicationApi } from './SharePublicationCoordinator';
import type { ShareUploadSession, ShareUploadTransport } from './ShareUploadManager';

export type RemoteShareStatus = 'draft' | 'uploading' | 'active' | 'revoked';

export type RemoteShareSummary = {
  id: string;
  status: RemoteShareStatus;
  recordingTitles: string[];
  recordingCount: number;
  trackCount: number;
  totalBytes?: number;
  createdAt: number;
  updatedAt: number;
  finalizedAt?: number;
  revokedAt?: number;
  shareUrl?: string;
};

export type RemoteShare = RemoteShareSummary & {
  manifest: PublishedPlaybackManifest;
};

export interface ShareRegistryApi {
  listShares(): Promise<RemoteShareSummary[]>;
  getShare(shareId: string): Promise<RemoteShare>;
}

export type ShareServiceClientDeps = {
  fetch?: typeof fetch;
  /** Authentication headers. A 401 retries once with `refresh: true`. */
  headers?: (options?: { refresh?: boolean }) => HeadersInit | Promise<HeadersInit>;
};

export class ShareServiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ShareServiceRequestError';
  }
}

export class ShareServiceClient implements SharePublicationApi, ShareUploadTransport, ShareRegistryApi {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, private readonly deps: ShareServiceClientDeps = {}) {
    this.origin = normalizeServiceOrigin(baseUrl);
    this.fetcher = deps.fetch ?? fetch.bind(globalThis);
  }

  async createShare(manifest: PublishedPlaybackManifest): Promise<void> {
    await this.request(`/api/shares/${segment(manifest.id)}`, {
      method: 'PUT',
      json: manifest,
      statuses: [200, 201, 204],
    });
  }

  async beginTrackUpload(input: {
    shareId: string;
    recordingId: string;
    trackId: string;
    mimeType: string;
    bytes: number;
  }, signal?: AbortSignal): Promise<ShareUploadSession> {
    const body = await this.requestJson(
      `/api/shares/${segment(input.shareId)}/recordings/${segment(input.recordingId)}/tracks/${segment(input.trackId)}/uploads`,
      {
        method: 'POST',
        json: { mimeType: input.mimeType, bytes: input.bytes },
        statuses: [200, 201],
        signal,
      },
    );
    return parseUploadSession(body, input.bytes);
  }

  async uploadTrackChunk(input: {
    uploadId: string;
    offset: number;
    totalBytes: number;
    chunk: Blob;
  }, signal?: AbortSignal): Promise<void> {
    const endExclusive = input.offset + input.chunk.size;
    if (!Number.isInteger(input.offset) || input.offset < 0 || endExclusive > input.totalBytes) {
      throw new Error('Invalid share upload chunk range');
    }
    const contentRange = `bytes ${input.offset}-${Math.max(input.offset, endExclusive - 1)}/${input.totalBytes}`;
    await this.request(`/api/share-uploads/${segment(input.uploadId)}/chunks/${input.offset}`, {
      method: 'PUT',
      body: input.chunk,
      headers: {
        'content-type': input.chunk.type || 'application/octet-stream',
        'content-range': contentRange,
      },
      statuses: [200, 201, 204],
      signal,
    });
  }

  async completeTrackUpload(input: {
    uploadId: string;
    totalBytes: number;
  }, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/share-uploads/${segment(input.uploadId)}/complete`, {
      method: 'POST',
      json: { totalBytes: input.totalBytes },
      statuses: [200, 204],
      signal,
    });
  }

  async finalizeShare(shareId: string): Promise<{ shareUrl: string }> {
    const body = await this.requestJson(`/api/shares/${segment(shareId)}/finalize`, {
      method: 'POST',
      statuses: [200],
    });
    const shareUrl = stringField(body, 'shareUrl');
    if (!shareUrl) throw new Error('Sharing service returned no share URL');
    return { shareUrl };
  }

  /** Revokes the public capability; retained owner recordings are untouched. */
  async revokeShare(shareId: string): Promise<void> {
    await this.request(`/api/shares/${segment(shareId)}/revoke`, {
      method: 'POST',
      statuses: [200, 204],
    });
  }

  async deleteShare(shareId: string): Promise<void> {
    await this.request(`/api/shares/${segment(shareId)}`, {
      method: 'DELETE',
      statuses: [200, 204],
    });
  }

  async listShares(): Promise<RemoteShareSummary[]> {
    const shares: RemoteShareSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const path = cursor == null
        ? '/api/shares?limit=50'
        : `/api/shares?limit=50&cursor=${encodeURIComponent(cursor)}`;
      const body = await this.requestJson(path, {
        method: 'GET',
        statuses: [200],
      });
      if (!isRecord(body) || !Array.isArray(body.shares)) {
        throw new Error('Sharing service returned an invalid share list');
      }
      shares.push(...body.shares.map(parseRemoteShareSummary));
      cursor = optionalStringField(body, 'nextCursor');
      if (cursor != null) {
        if (seenCursors.has(cursor)) throw new Error('Sharing service returned a repeated share-list cursor');
        seenCursors.add(cursor);
      }
    } while (cursor != null);
    return shares;
  }

  async getShare(shareId: string): Promise<RemoteShare> {
    return parseRemoteShare(await this.requestJson(`/api/shares/${segment(shareId)}`, {
      method: 'GET',
      statuses: [200],
    }));
  }

  private async requestJson(path: string, options: RequestOptions): Promise<unknown> {
    const response = await this.request(path, options);
    return await response.json().catch(() => {
      throw new Error(`Sharing service returned invalid JSON (${response.status})`);
    });
  }

  private async request(path: string, options: RequestOptions): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refresh = attempt > 0;
      const authHeaders = await this.deps.headers?.(refresh ? { refresh: true } : undefined);
      const headers = new Headers(authHeaders);
      if (options.json !== undefined) headers.set('content-type', 'application/json');
      new Headers(options.headers).forEach((value, name) => headers.set(name, value));

      const response = await this.fetcher(this.origin + path, {
        method: options.method,
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
        signal: options.signal,
        cache: 'no-store',
      });
      if (response.status === 401 && attempt === 0 && this.deps.headers) continue;
      if (!options.statuses.includes(response.status)) {
        const detail = await response.text().catch(() => '');
        const suffix = detail.trim() ? `: ${detail.trim().slice(0, 240)}` : '';
        throw new ShareServiceRequestError(
          `Sharing service ${options.method} ${path} failed (${response.status})${suffix}`,
          response.status,
          responseErrorCode(detail),
        );
      }
      return response;
    }
    throw new Error('Sharing service authentication retry did not complete');
  }
}

type RequestOptions = {
  method: string;
  statuses: readonly number[];
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export function normalizeServiceOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Sharing service URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Sharing service URL must be a bare HTTPS origin');
  }
  return url.origin;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function parseUploadSession(value: unknown, totalBytes: number): ShareUploadSession {
  const uploadId = stringField(value, 'uploadId');
  if (!uploadId) throw new Error('Sharing service returned no upload id');
  const chunkSize = numberField(value, 'chunkSize');
  const offset = numberField(value, 'offset');
  if (chunkSize != null && (!Number.isInteger(chunkSize) || chunkSize <= 0)) {
    throw new Error('Sharing service returned an invalid chunk size');
  }
  if (offset != null && (!Number.isInteger(offset) || offset < 0 || offset > totalBytes)) {
    throw new Error('Sharing service returned an invalid upload offset');
  }
  return {
    uploadId,
    ...(chunkSize != null ? { chunkSize } : {}),
    ...(offset != null ? { offset } : {}),
  };
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function nonNegativeIntegerField(value: unknown, field: string): number | undefined {
  const candidate = numberField(value, field);
  return candidate != null && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function optionalNonNegativeIntegerField(value: Record<string, unknown>, field: string): number | undefined {
  if (value[field] == null) return undefined;
  const candidate = nonNegativeIntegerField(value, field);
  if (candidate == null) throw new Error(`Sharing service returned an invalid ${field}`);
  return candidate;
}

function stringArrayField(value: Record<string, unknown>, field: string): string[] | undefined {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === 'string')) return undefined;
  return [...candidate];
}

function parseRemoteShare(value: unknown): RemoteShare {
  const summary = parseRemoteShareSummary(value);
  if (!isRecord(value)) throw new Error('Sharing service returned an invalid share');
  return {
    ...summary,
    manifest: parseRemoteManifest(value.manifest, summary.id),
  };
}

function parseRemoteShareSummary(value: unknown): RemoteShareSummary {
  if (!isRecord(value)) throw new Error('Sharing service returned an invalid share');
  const id = stringField(value, 'id');
  const status = value.status;
  const createdAt = numberField(value, 'createdAt');
  const updatedAt = numberField(value, 'updatedAt');
  const recordingCount = nonNegativeIntegerField(value, 'recordingCount');
  const trackCount = nonNegativeIntegerField(value, 'trackCount');
  const recordingTitles = stringArrayField(value, 'recordingTitles');
  if (!id || !isRemoteShareStatus(status) || createdAt == null || updatedAt == null
    || recordingCount == null || trackCount == null || !recordingTitles) {
    throw new Error('Sharing service returned an invalid share');
  }
  const totalBytes = optionalNonNegativeIntegerField(value, 'totalBytes');
  const finalizedAt = optionalNumberField(value, 'finalizedAt');
  const revokedAt = optionalNumberField(value, 'revokedAt');
  const shareUrl = optionalStringField(value, 'shareUrl');
  if (status === 'active' && !shareUrl) {
    throw new Error('Sharing service returned an active share without a URL');
  }
  return {
    id,
    status,
    recordingTitles,
    recordingCount,
    trackCount,
    ...(totalBytes != null ? { totalBytes } : {}),
    createdAt,
    updatedAt,
    ...(finalizedAt != null ? { finalizedAt } : {}),
    ...(revokedAt != null ? { revokedAt } : {}),
    ...(shareUrl ? { shareUrl } : {}),
  };
}

function parseRemoteManifest(value: unknown, expectedShareId: string): PublishedPlaybackManifest {
  if (!isRecord(value)
    || value.id !== expectedShareId
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
    || !Array.isArray(value.recordings)) {
    throw new Error('Sharing service returned an invalid published manifest');
  }
  return structuredClone(value) as PublishedPlaybackManifest;
}

function optionalNumberField(value: Record<string, unknown>, field: string): number | undefined {
  if (value[field] == null) return undefined;
  const candidate = numberField(value, field);
  if (candidate == null) throw new Error(`Sharing service returned an invalid ${field}`);
  return candidate;
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  if (value[field] == null) return undefined;
  const candidate = stringField(value, field);
  if (!candidate) throw new Error(`Sharing service returned an invalid ${field}`);
  return candidate;
}

function isRemoteShareStatus(value: unknown): value is RemoteShareStatus {
  return value === 'draft' || value === 'uploading' || value === 'active' || value === 'revoked';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseErrorCode(detail: string): string | undefined {
  try {
    return stringField(JSON.parse(detail), 'code');
  } catch {
    return undefined;
  }
}
