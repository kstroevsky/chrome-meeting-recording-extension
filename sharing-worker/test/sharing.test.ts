import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
  type D1Migration,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARING_CONTRACT_LIMITS } from '../../src/shared/sharingContract';
import worker from '../src/index';

const origin = 'https://sharing.test';
const extensionOrigin = 'chrome-extension://test-extension';
const ownerSessions = new Map<string, string>();
let googleIdentityRequests = 0;
let driveMediaRequests = 0;
const driveBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);

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
  driveMediaRequests = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    const endpoint = `${parsed.origin}${parsed.pathname}`;
    if (endpoint === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'sharing-reader-token', expires_in: 3600 });
    }
    if (endpoint === 'https://www.googleapis.com/drive/v3/files/drive-file-1/revisions/revision-1') {
      if (parsed.searchParams.get('alt') === 'media') {
        driveMediaRequests += 1;
        const range = new Headers(init?.headers).get('range');
        const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
        if (!match) return new Response('range required', { status: 400 });
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), driveBytes.byteLength - 1);
        return new Response(driveBytes.slice(start, end + 1), {
          status: 206,
          headers: {
            'content-type': 'video/webm',
            'content-range': `bytes ${start}-${end}/${driveBytes.byteLength}`,
            'content-length': String(end - start + 1),
          },
        });
      }
      return Response.json({
        id: 'revision-1',
        size: String(driveBytes.byteLength),
        mimeType: 'video/webm',
        keepForever: true,
      });
    }
    if (endpoint !== 'https://oauth2.googleapis.com/tokeninfo') {
      throw new Error(`Unexpected Google request: ${url}`);
    }
    googleIdentityRequests += 1;
    const identityToken = parsed.searchParams.get('access_token');
    const subject = identityToken === 'owner-a-token'
      ? 'subject-owner-a'
      : identityToken === 'owner-b-token'
        ? 'subject-owner-b'
        : identityToken === 'wrong-audience-token'
          ? 'subject-wrong-audience'
        : null;
    if (!subject) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({
      sub: subject,
      aud: identityToken === 'wrong-audience-token'
        ? 'another-client.apps.googleusercontent.com'
        : 'test-client.apps.googleusercontent.com',
    }), {
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
    expect((await registerOrigin()).status).toBe(201);

    const firstFinalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    expect(firstFinalize.status).toBe(200);
    const first = await firstFinalize.json<{ shareUrl: string }>();
    expect(first.shareUrl).toMatch(/^https:\/\/sharing\.test\/s\/[A-Za-z0-9_-]{40,}$/);
    expect(first.shareUrl).not.toContain('share-owner-id');
    const storedKey = await env.SHARING_DB.prepare(
      'SELECT capability_key_id FROM shares WHERE id = ?',
    ).bind('share-owner-id').first<{ capability_key_id: string }>();
    expect(storedKey?.capability_key_id).toBe('v1');

    const retryFinalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    expect((await retryFinalize.json<{ shareUrl: string }>()).shareUrl).toBe(first.shareUrl);

    const registry = await ownerFetch('/api/shares');
    const registryBody = await registry.json<{ shares: Array<{ id: string; status: string; shareUrl: string }> }>();
    expect(registryBody.shares).toEqual([
      expect.objectContaining({ id: 'share-owner-id', status: 'active', shareUrl: first.shareUrl }),
    ]);
    expect(googleIdentityRequests).toBe(1);
  });

  it('returns paginated registry summaries without embedding full manifests', async () => {
    expect((await putManifest()).status).toBe(201);
    const second = structuredClone(manifest);
    second.id = 'share-owner-id-2';
    second.recordings[0].id = 'public-recording-id-2';
    second.recordings[0].title = 'Second customer call';
    second.recordings[0].tracks[0].mediaEndpoint = '/media/recordings/public-recording-id-2/tracks/tab-track';
    expect((await ownerFetch('/api/shares/share-owner-id-2', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(second),
    })).status).toBe(201);

    const firstPage = await ownerFetch('/api/shares?limit=1');
    const firstBody = await firstPage.json<{ shares: any[]; nextCursor?: string }>();
    expect(firstBody.shares).toHaveLength(1);
    expect(firstBody.shares[0]).toEqual(expect.objectContaining({
      recordingTitles: expect.any(Array),
      recordingCount: 1,
      trackCount: 1,
      totalBytes: 6,
    }));
    expect(firstBody.shares[0].manifest).toBeUndefined();
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const secondPage = await ownerFetch(`/api/shares?limit=1&cursor=${firstBody.nextCursor}`);
    const secondBody = await secondPage.json<{ shares: any[]; nextCursor?: string }>();
    expect(secondBody.shares).toHaveLength(1);
    expect(secondBody.shares[0].manifest).toBeUndefined();
  });

  it('keeps share pagination stable when rows before the cursor are deleted', async () => {
    expect((await putManifest()).status).toBe(201);
    const second = structuredClone(manifest);
    second.id = 'share-owner-id-2';
    second.recordings[0].id = 'public-recording-id-2';
    second.recordings[0].tracks[0].mediaEndpoint = '/media/recordings/public-recording-id-2/tracks/tab-track';
    expect((await ownerFetch('/api/shares/share-owner-id-2', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(second),
    })).status).toBe(201);

    const firstPage = await ownerFetch('/api/shares?limit=1');
    const firstBody = await firstPage.json<{ shares: Array<{ id: string }>; nextCursor?: string }>();
    expect(firstBody.shares).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    await env.SHARING_DB.prepare('DELETE FROM shares WHERE id = ?').bind(firstBody.shares[0].id).run();

    const secondPage = await ownerFetch(`/api/shares?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`);
    const secondBody = await secondPage.json<{ shares: Array<{ id: string }> }>();
    expect(secondBody.shares).toHaveLength(1);
    expect(secondBody.shares[0].id).not.toBe(firstBody.shares[0].id);
  });

  it('rejects malformed share-list cursors', async () => {
    const response = await ownerFetch('/api/shares?cursor=not-a-valid-cursor');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_CURSOR' });
  });

  it('rejects a canonical manifest that exceeds the D1 persistence budget', async () => {
    const oversized = structuredClone(manifest) as any;
    oversized.recordings[0].transcript = {
      source: 'meet-captions',
      segments: Array.from({ length: 8_000 }, (_, index) => ({
        tStartMs: index * 10,
        tEndMs: index * 10 + 5,
        speaker: 'speaker'.repeat(12),
        text: 'transcript'.repeat(6),
      })),
    };
    const body = JSON.stringify(oversized);
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(bytes).toBeGreaterThan(SHARING_CONTRACT_LIMITS.manifestBytes);
    expect(bytes).toBeLessThanOrEqual(SHARING_CONTRACT_LIMITS.manifestRequestBytes);

    const response = await ownerFetch('/api/shares/share-owner-id', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: 'MANIFEST_TOO_LARGE' });
  });

  it('streams a bounded Drive revision range before revocation', async () => {
    await putManifest();
    expect((await registerOrigin()).status).toBe(201);

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
    expect(driveMediaRequests).toBe(1);

    expect((await ownerFetch('/api/shares/share-owner-id/revoke', { method: 'POST' })).status).toBe(204);
    const denied = await worker.fetch(new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie: cookie!, range: 'bytes=0-1' } },
    ), env);
    expect(denied.status).toBe(410);
    expect(await denied.json()).toEqual({ code: 'SHARE_REVOKED' });
    expect(driveMediaRequests).toBe(1);
  });

  it('uses a fixed 30-hour read-through cache without extending TTL on hits', async () => {
    await putManifest();
    await registerOrigin();
    const finalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    const { shareUrl } = await finalize.json<{ shareUrl: string }>();
    const open = await worker.fetch(new Request(shareUrl), env);
    const cookie = open.headers.get('set-cookie')!;
    const mediaRequest = () => new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie, range: 'bytes=0-5' } },
    );

    const ctx = createExecutionContext();
    const first = await worker.fetch(mediaRequest(), env, ctx);
    expect(Array.from(new Uint8Array(await first.arrayBuffer()))).toEqual([10, 20, 30, 40, 50, 60]);
    await waitOnExecutionContext(ctx);
    expect(driveMediaRequests).toBe(1);

    const cachedBefore = await env.SHARING_DB.prepare(
      'SELECT cache_key, cached_at, expires_at FROM media_cache_entries LIMIT 1',
    ).first<{ cache_key: string; cached_at: number; expires_at: number }>();
    expect(cachedBefore).not.toBeNull();
    expect(cachedBefore!.expires_at - cachedBefore!.cached_at).toBe(30 * 60 * 60 * 1000);

    const second = await worker.fetch(mediaRequest(), env);
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(driveMediaRequests).toBe(1);
    const cachedAfter = await env.SHARING_DB.prepare(
      'SELECT cached_at, expires_at FROM media_cache_entries WHERE cache_key = ?',
    ).bind(cachedBefore!.cache_key).first<{ cached_at: number; expires_at: number }>();
    expect(cachedAfter).toEqual({
      cached_at: cachedBefore!.cached_at,
      expires_at: cachedBefore!.expires_at,
    });
  });

  it('replaces an expired cache entry immediately after a Drive fallback', async () => {
    await putManifest();
    await registerOrigin();
    const finalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    const { shareUrl } = await finalize.json<{ shareUrl: string }>();
    const open = await worker.fetch(new Request(shareUrl), env);
    const cookie = open.headers.get('set-cookie')!;
    const mediaRequest = () => new Request(
      `${origin}/media/recordings/public-recording-id/tracks/tab-track`,
      { headers: { cookie, range: 'bytes=0-5' } },
    );

    const firstCtx = createExecutionContext();
    const first = await worker.fetch(mediaRequest(), env, firstCtx);
    expect(first.status).toBe(206);
    await first.arrayBuffer();
    await waitOnExecutionContext(firstCtx);

    const cached = await env.SHARING_DB.prepare(
      'SELECT cache_key FROM media_cache_entries LIMIT 1',
    ).first<{ cache_key: string }>();
    expect(cached).not.toBeNull();
    await env.SHARING_DB.prepare(
      'UPDATE media_cache_entries SET cached_at = 1, expires_at = 2 WHERE cache_key = ?',
    ).bind(cached!.cache_key).run();

    const secondCtx = createExecutionContext();
    const second = await worker.fetch(mediaRequest(), env, secondCtx);
    expect(second.status).toBe(206);
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual([10, 20, 30, 40, 50, 60]);
    await waitOnExecutionContext(secondCtx);

    expect(driveMediaRequests).toBe(2);
    const refreshed = await env.SHARING_DB.prepare(
      'SELECT cached_at, expires_at FROM media_cache_entries WHERE cache_key = ?',
    ).bind(cached!.cache_key).first<{ cached_at: number; expires_at: number }>();
    expect(refreshed).not.toBeNull();
    expect(refreshed!.cached_at).toBeGreaterThan(2);
    expect(refreshed!.expires_at - refreshed!.cached_at).toBe(30 * 60 * 60 * 1000);
  });

  it('deletes publication metadata and exact cache objects without deleting Drive media', async () => {
    await putManifest();
    await registerOrigin();
    await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });

    const asset = await env.SHARING_DB.prepare(
      'SELECT id FROM media_assets WHERE share_id = ?',
    ).bind('share-owner-id').first<{ id: string }>();
    expect(asset).not.toBeNull();
    const cacheKey = `cache/v1/${asset!.id}/revision-1/0-5`;
    await env.SHARING_MEDIA.put(cacheKey, driveBytes);
    await env.SHARING_DB.batch([
      env.SHARING_DB.prepare(
        'INSERT INTO media_cache_entries (cache_key, asset_id, bytes, cached_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(cacheKey, asset!.id, 6, Date.now(), Date.now() + 60_000),
      env.SHARING_DB.prepare(
        'UPDATE media_cache_budget SET live_bytes = live_bytes + 6 WHERE singleton = 1',
      ),
    ]);
    expect(await env.SHARING_MEDIA.head(cacheKey)).not.toBeNull();

    const deleted = await ownerFetch('/api/shares/share-owner-id', { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await env.SHARING_MEDIA.head(cacheKey)).toBeNull();
    expect(await env.SHARING_DB.prepare('SELECT id FROM shares WHERE id = ?')
      .bind('share-owner-id').first()).toBeNull();
    expect(await env.SHARING_DB.prepare('SELECT id FROM media_assets WHERE share_id = ?')
      .bind('share-owner-id').first()).toBeNull();

    expect((await ownerFetch('/api/shares/share-owner-id', { method: 'DELETE' })).status).toBe(204);
    expect((await ownerFetchAs('owner-b-token', '/api/shares/share-owner-id', { method: 'DELETE' })).status).toBe(204);
  });

  it('serves a real session-protected synchronized web player', async () => {
    await putManifest();
    await registerOrigin();
    const finalize = await ownerFetch('/api/shares/share-owner-id/finalize', { method: 'POST' });
    const { shareUrl } = await finalize.json<{ shareUrl: string }>();
    const open = await worker.fetch(new Request(shareUrl), env);
    const cookie = open.headers.get('set-cookie');

    const page = await worker.fetch(new Request(`${origin}/viewer`, { headers: { cookie: cookie! } }), env);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
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

  it('does not expose the legacy direct-to-R2 multipart publication API', async () => {
    await putManifest();
    const response = await ownerFetch(
      '/api/shares/share-owner-id/recordings/public-recording-id/tracks/tab-track/uploads',
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
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

  it('rejects Google access tokens issued for another OAuth client', async () => {
    const response = await worker.fetch(new Request(`${origin}/api/auth/session`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-audience-token',
        origin: extensionOrigin,
      },
    }), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'OWNER_IDENTITY_INVALID' });
  });

  it('isolates shares and Drive-origin registration by authenticated owner identity', async () => {
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

    const ownerBOrigin = await ownerFetchAs(
      'owner-b-token',
      '/api/shares/share-owner-id/recordings/public-recording-id/tracks/tab-track/origin',
      {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(driveOriginBody()),
      },
    );
    expect(ownerBOrigin.status).toBe(404);
    expect(await ownerBOrigin.json()).toEqual({ code: 'SHARE_NOT_FOUND' });

    expect((await registerOrigin()).status).toBe(201);
  });
});

async function putManifest(): Promise<Response> {
  return ownerFetch('/api/shares/share-owner-id', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
}

function driveOriginBody() {
  return {
    fileId: 'drive-file-1',
    revisionId: 'revision-1',
    bytes: 6,
    mimeType: 'video/webm',
    permissionId: 'permission-1',
  };
}

async function registerOrigin(): Promise<Response> {
  return ownerFetch(
    '/api/shares/share-owner-id/recordings/public-recording-id/tracks/tab-track/origin',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(driveOriginBody()),
    },
  );
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
