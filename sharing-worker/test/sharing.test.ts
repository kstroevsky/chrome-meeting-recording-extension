import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const origin = 'https://sharing.test';
const extensionOrigin = 'chrome-extension://test-extension';
const ownerSessions = new Map<string, string>();
let googleIdentityRequests = 0;

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
  vi.restoreAllMocks();
  ownerSessions.clear();
  googleIdentityRequests = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== 'https://openidconnect.googleapis.com/v1/userinfo') {
      throw new Error(`Unexpected owner identity request: ${url}`);
    }
    googleIdentityRequests += 1;
    const authorization = new Headers(init?.headers).get('authorization');
    const subject = authorization === 'Bearer owner-a-token'
      ? 'subject-owner-a'
      : authorization === 'Bearer owner-b-token'
        ? 'subject-owner-b'
        : null;
    if (!subject) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ sub: subject }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
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
    expect(googleIdentityRequests).toBe(1);
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

    expect((await ownerFetch('/api/shares/share-owner-id/revoke', { method: 'POST' })).status).toBe(204);
    const denied = await worker.fetch(new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie: cookie!, range: 'bytes=0-1' } },
    ), env);
    expect(denied.status).toBe(410);
    expect(await denied.json()).toEqual({ code: 'SHARE_REVOKED' });
  });

  it('permanently deletes published media and metadata after revoking access', async () => {
    await putManifest();
    const upload = await beginTrack();
    await uploadBytes(upload.uploadId, new Uint8Array([1, 2, 3, 4, 5, 6]));
    await completeTrack(upload.uploadId);
    await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });

    const track = await env.SHARING_DB.prepare(
      'SELECT object_key FROM share_tracks WHERE share_id = ?',
    ).bind('share-owner-id').first<{ object_key: string }>();
    expect(track).not.toBeNull();
    expect(await env.SHARING_MEDIA.head(track!.object_key)).not.toBeNull();

    const deleted = await ownerFetch('/api/shares/share-owner-id', { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await env.SHARING_MEDIA.head(track!.object_key)).toBeNull();
    expect(await env.SHARING_DB.prepare('SELECT id FROM shares WHERE id = ?')
      .bind('share-owner-id').first()).toBeNull();
    expect(await env.SHARING_DB.prepare('SELECT id FROM share_uploads WHERE share_id = ?')
      .bind('share-owner-id').first()).toBeNull();
  });

  it('serves a real session-protected synchronized web player', async () => {
    await putManifest();
    const upload = await beginTrack();
    await uploadBytes(upload.uploadId, new Uint8Array([1, 2, 3, 4, 5, 6]));
    await completeTrack(upload.uploadId);
    const finalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    const { shareUrl } = await finalize.json<{ shareUrl: string }>();
    const open = await worker.fetch(new Request(shareUrl), env);
    const cookie = open.headers.get('set-cookie');

    const page = await worker.fetch(new Request(`${origin}/viewer`, { headers: { cookie: cookie! } }), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="recording-title"');
    expect(html).toContain('id="mixers"');
    expect(html).toContain('id="transcript"');
    expect(html).toContain('src="/viewer/app.js"');
    expect(html).not.toContain('id="manifest"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");

    const app = await worker.fetch(new Request(`${origin}/viewer/app.js`, { headers: { cookie: cookie! } }), env);
    expect(app.status).toBe(200);
    const script = await app.text();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('fetch("/viewer/manifest"');
    expect(script).toContain('captureStartOffsetMs');
    expect(script).toContain('var PlaybackClock = class');
    expect(script).toContain('DRIFT_RESYNC_MS = 150');
    expect(script).not.toContain('Math.abs(item.element.currentTime - target) * 1000 > 150');
    expect(script).toContain('slider.type = "range"');
    expect(script).toContain('syncTranscript');
    expect(script).toContain('renderTopics');
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

  it('stores only the canonical public manifest shape', async () => {
    const canonical = {
      ...manifest,
      recordings: [{
        ...manifest.recordings[0],
        durationMs: 42_000,
        transcript: {
          source: 'meet-captions' as const,
          segments: [{ tStartMs: 1_000, tEndMs: 2_000, speaker: 'A', text: 'Hello' }],
        },
        topics: [{
          id: 'topic-1',
          keywords: ['hello'],
          spans: [{ tStartMs: 1_000, tEndMs: 2_000 }],
          totalMs: 1_000,
          importance: 0.8,
        }],
        notations: [{ id: 'note-1', tStartMs: 1_500, tEndMs: 1_750, endedBy: 'user' as const, text: 'Check this' }],
      }],
    };
    const untrusted = structuredClone(canonical) as typeof canonical & { privateSourceId?: string };
    untrusted.privateSourceId = 'history-private-123';
    Object.assign(untrusted.recordings[0], { driveFileId: 'drive-secret' });
    Object.assign(untrusted.recordings[0].tracks[0], {
      opfsKey: 'library/history-private-123/customer-name.webm',
    });
    Object.assign(untrusted.recordings[0].transcript.segments[0], { sourceFileId: 'drive-transcript-secret' });
    Object.assign(untrusted.recordings[0].topics[0].spans[0], { privateEmbeddingId: 'embedding-secret' });
    Object.assign(untrusted.recordings[0].notations[0], { ownerRecordingId: 'history-private-note' });

    const response = await ownerFetch('/api/shares/share-owner-id', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(untrusted),
    });
    expect(response.status).toBe(201);

    const stored = await env.SHARING_DB.prepare(
      'SELECT manifest_json FROM shares WHERE id = ?',
    ).bind('share-owner-id').first<{ manifest_json: string }>();
    expect(JSON.parse(stored!.manifest_json)).toEqual(canonical);
    expect(stored!.manifest_json).not.toMatch(/history-private|drive-.*secret|library\/|embedding-secret/);
  });

  it('treats equivalent manifests with different JSON property order as the same snapshot', async () => {
    expect((await putManifest()).status).toBe(201);
    const reordered = {
      recordings: manifest.recordings.map((recording) => ({
        downloadsEnabled: recording.downloadsEnabled,
        tracks: recording.tracks.map((track) => ({
          mediaEndpoint: track.mediaEndpoint,
          captureStartOffsetMs: track.captureStartOffsetMs,
          bytes: track.bytes,
          mimeType: track.mimeType,
          stream: track.stream,
          id: track.id,
        })),
        createdAt: recording.createdAt,
        title: recording.title,
        id: recording.id,
      })),
      createdAt: manifest.createdAt,
      id: manifest.id,
    };

    const response = await ownerFetch('/api/shares/share-owner-id', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reordered),
    });
    expect(response.status).toBe(200);
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
    const session = await ownerSession('owner-a-token');
    const badOrigin = await worker.fetch(new Request(`${origin}/api/shares`, {
      headers: { authorization: `Bearer ${session}`, origin: 'https://evil.example' },
    }), env);
    expect(badOrigin.status).toBe(403);

    const badToken = await worker.fetch(new Request(`${origin}/api/shares`, {
      headers: { authorization: 'Bearer wrong', origin: 'chrome-extension://test-extension' },
    }), env);
    expect(badToken.status).toBe(401);
  });

  it('isolates shares and upload sessions by authenticated owner identity', async () => {
    expect((await putManifest()).status).toBe(201);
    const ownedShare = await env.SHARING_DB.prepare(
      'SELECT owner_id FROM shares WHERE id = ?',
    ).bind('share-owner-id').first<{ owner_id: string }>();
    expect(ownedShare?.owner_id).toBe('google:subject-owner-a');

    const ownerBRegistry = await ownerFetchAs('owner-b-token', '/api/shares');
    expect(await ownerBRegistry.json()).toEqual({ shares: [] });

    const ownerBGet = await ownerFetchAs('owner-b-token', '/api/shares/share-owner-id');
    expect(ownerBGet.status).toBe(404);
    expect(await ownerBGet.json()).toEqual({ code: 'SHARE_NOT_FOUND' });

    const ownerBPut = await ownerFetchAs('owner-b-token', '/api/shares/share-owner-id', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    expect(ownerBPut.status).toBe(404);

    const ownerBRevoke = await ownerFetchAs('owner-b-token', '/api/shares/share-owner-id/revoke', {
      method: 'POST',
    });
    expect(ownerBRevoke.status).toBe(404);

    const upload = await beginTrack();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const ownerBChunk = await ownerFetchAs('owner-b-token', `/api/share-uploads/${encodeURIComponent(upload.uploadId)}/chunks/0`, {
      method: 'PUT',
      headers: {
        'content-type': 'video/webm',
        'content-range': 'bytes 0-5/6',
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });
    expect(ownerBChunk.status).toBe(410);
    expect(await ownerBChunk.json()).toEqual(expect.objectContaining({ code: 'UPLOAD_SESSION_GONE' }));

    expect((await uploadBytes(upload.uploadId, bytes)).status).toBe(204);
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
  return ownerFetchAs('owner-a-token', path, init);
}

async function ownerFetchAs(identityToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers({
    authorization: `Bearer ${await ownerSession(identityToken)}`,
    origin: extensionOrigin,
  });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return worker.fetch(new Request(origin + path, { ...init, headers }), env);
}

async function ownerSession(identityToken: string): Promise<string> {
  const cached = ownerSessions.get(identityToken);
  if (cached) return cached;
  const response = await worker.fetch(new Request(`${origin}/api/auth/session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${identityToken}`,
      origin: extensionOrigin,
    },
  }), env);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string }>();
  ownerSessions.set(identityToken, body.token);
  return body.token;
}
