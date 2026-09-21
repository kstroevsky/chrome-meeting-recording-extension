import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

const origin = 'https://sharing.test';
const ownerHeaders = {
  authorization: 'Bearer test-owner-token',
  origin: 'chrome-extension://test-extension',
};

const manifest = {
  id: 'share-owner-id',
  createdAt: 1_790_000_000_000,
  recordings: [
    {
      id: 'public-recording-id',
      title: 'Customer call',
      createdAt: 1_790_000_000_000,
      tracks: [
        {
          id: 'tab-track',
          stream: 'tab',
          mimeType: 'video/webm',
          bytes: 6,
          captureStartOffsetMs: 0,
          mediaEndpoint: '/media/recordings/public-recording-id/tracks/tab-track',
        },
      ],
      downloadsEnabled: false,
    },
  ],
};

beforeEach(async () => {
  await reset();
  const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.SHARING_DB, testEnv.TEST_D1_MIGRATIONS);
});

describe('sharing worker vertical slice', () => {
  it('keeps owner id separate from the viewer capability and exposes an owner registry', async () => {
    expect((await putManifest()).status).toBe(201);
    const upload = await beginTrack();
    expect(upload.chunkSize).toBe(8 * 1024 * 1024);
    await uploadBytes(upload.uploadId, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect((await completeTrack(upload.uploadId)).status).toBe(204);

    const firstFinalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    expect(firstFinalize.status).toBe(200);
    const first = await firstFinalize.json<{ shareUrl: string }>();
    expect(first.shareUrl).toMatch(/^https:\/\/sharing\.test\/s\/[A-Za-z0-9_-]{40,}$/);
    expect(first.shareUrl).not.toContain('share-owner-id');

    const retryFinalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    expect((await retryFinalize.json<{ shareUrl: string }>()).shareUrl).toBe(first.shareUrl);

    const registry = await ownerFetch('/api/shares');
    const registryBody = await registry.json<{ shares: Array<{ id: string; status: string; shareUrl: string }> }>();
    expect(registryBody.shares).toEqual([
      expect.objectContaining({ id: 'share-owner-id', status: 'active', shareUrl: first.shareUrl }),
    ]);
  });

  it('treats a committed chunk retry as idempotent and supports ranged media before revocation', async () => {
    await putManifest();
    const upload = await beginTrack();
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60]);

    expect((await uploadBytes(upload.uploadId, bytes)).status).toBe(204);
    expect((await uploadBytes(upload.uploadId, bytes)).status).toBe(204);
    await completeTrack(upload.uploadId);

    const finalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    const { shareUrl } = await finalize.json<{ shareUrl: string }>();
    const open = await worker.fetch(new Request(shareUrl), env);
    expect(open.status).toBe(303);
    const cookie = open.headers.get('set-cookie');
    expect(cookie).toContain('__Host-share_session=');

    const media = await worker.fetch(new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie: cookie!, range: 'bytes=2-4' } },
    ), env);
    expect(media.status).toBe(206);
    expect(media.headers.get('content-range')).toBe('bytes 2-4/6');
    expect(Array.from(new Uint8Array(await media.arrayBuffer()))).toEqual([30, 40, 50]);

    expect((await ownerFetch('/api/shares/share-owner-id', { method: 'DELETE' })).status).toBe(204);
    const denied = await worker.fetch(new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie: cookie!, range: 'bytes=0-1' } },
    ), env);
    expect(denied.status).toBe(410);
    expect(await denied.json()).toEqual({ code: 'SHARE_REVOKED' });
  });

  it('rejects a different manifest reusing the same owner share id', async () => {
    expect((await putManifest()).status).toBe(201);
    const changed = structuredClone(manifest);
    changed.recordings[0].title = 'Different snapshot';
    const response = await ownerFetch('/api/shares/share-owner-id', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ code: 'SHARE_ID_CONFLICT' }));
  });

  it('returns UPLOAD_SESSION_GONE and permits a fresh multipart session', async () => {
    await putManifest();
    const first = await beginTrack();
    const backend = await env.SHARING_DB.prepare(
      'SELECT object_key, r2_upload_id FROM share_uploads WHERE id = ?',
    ).bind(first.uploadId).first<{ object_key: string; r2_upload_id: string }>();
    expect(backend).not.toBeNull();

    await env.SHARING_MEDIA.resumeMultipartUpload(backend!.object_key, backend!.r2_upload_id).abort();
    const gone = await uploadBytes(first.uploadId, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual(expect.objectContaining({ code: 'UPLOAD_SESSION_GONE' }));

    const replacement = await beginTrack();
    expect(replacement.uploadId).not.toBe(first.uploadId);
    expect(replacement.offset).toBe(0);
  });

  it('requires both the configured extension origin and owner bearer token', async () => {
    const badOrigin = await worker.fetch(new Request(`${origin}/api/shares`, {
      headers: { authorization: 'Bearer test-owner-token', origin: 'https://evil.example' },
    }), env);
    expect(badOrigin.status).toBe(403);

    const badToken = await worker.fetch(new Request(`${origin}/api/shares`, {
      headers: { authorization: 'Bearer wrong', origin: 'chrome-extension://test-extension' },
    }), env);
    expect(badToken.status).toBe(401);
  });
});

async function putManifest(): Promise<Response> {
  return ownerFetch('/api/shares/share-owner-id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
}

async function beginTrack(): Promise<{ uploadId: string; chunkSize: number; offset: number }> {
  const response = await ownerFetch(
    '/api/shares/share-owner-id/recordings/public-recording-id/tracks/tab-track/uploads',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mimeType: 'video/webm', bytes: 6 }),
    },
  );
  expect(response.status).toBe(201);
  return response.json();
}

async function uploadBytes(uploadId: string, bytes: Uint8Array): Promise<Response> {
  return ownerFetch(`/api/share-uploads/${encodeURIComponent(uploadId)}/chunks/0`, {
    method: 'PUT',
    headers: {
      'content-type': 'video/webm',
      'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
}

async function completeTrack(uploadId: string): Promise<Response> {
  return ownerFetch(`/api/share-uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ totalBytes: 6 }),
  });
}

async function ownerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(ownerHeaders);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return worker.fetch(new Request(origin + path, { ...init, headers }), env);
}
