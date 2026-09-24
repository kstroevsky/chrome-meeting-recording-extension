import {
  cookieValue,
  signViewerSession,
  verifyViewerSession,
  viewerSessionTtl,
  type ViewerSession,
} from '../auth/capability';
import { sha256Base64Url } from '../auth/crypto';
import {
  MAX_MEDIA_RESPONSE_BYTES,
  cacheMediaRange,
  getCachedMedia,
  mediaCacheKey,
} from '../cache/mediaCache';
import { fetchDriveRevisionRange } from '../drive/DriveClient';
import { parseRange } from '../http/range';
import { json } from '../http/responses';
import { getShare, type ShareRow } from '../shares/ShareRepository';
import { viewerAppScript } from './appAsset';
import { viewerShell } from './shell';

const SESSION_COOKIE = '__Host-share_session';

export async function routeViewerRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const capabilityMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
  if (capabilityMatch && request.method === 'GET') {
    return openCapability(capabilityMatch[1], request, env);
  }

  if (url.pathname === '/viewer' && request.method === 'GET') {
    const session = await requireViewerSession(request, env);
    if (session instanceof Response) return session;
    return viewerShell();
  }

  if (url.pathname === '/viewer/app.js' && request.method === 'GET') {
    const session = await requireViewerSession(request, env);
    if (session instanceof Response) return session;
    return viewerAppScript();
  }

  if (url.pathname === '/viewer/manifest' && request.method === 'GET') {
    const session = await requireViewerSession(request, env);
    if (session instanceof Response) return session;
    const share = await getShare(env.SHARING_DB, session.shareId);
    if (!share || share.status !== 'active') return json({ code: 'SHARE_REVOKED' }, 410);
    return json(JSON.parse(share.manifest_json), 200, { 'cache-control': 'no-store' });
  }

  const mediaMatch = /^\/media\/recordings\/([^/]+)\/tracks\/([^/]+)$/.exec(url.pathname);
  if (mediaMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveMedia(
      decodeURIComponent(mediaMatch[1]),
      decodeURIComponent(mediaMatch[2]),
      request,
      env,
      ctx,
    );
  }

  return null;
}

async function openCapability(encodedCapability: string, request: Request, env: Env): Promise<Response> {
  const capability = decodeURIComponent(encodedCapability);
  const capabilityHash = await sha256Base64Url(capability);
  const share = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version, capability_key_id,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE capability_hash = ? LIMIT 1`,
  ).bind(capabilityHash).first<ShareRow>();
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status !== 'active') return json({ code: 'SHARE_REVOKED' }, 410);

  const ttl = viewerSessionTtl(env);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = await signViewerSession({
    shareId: share.id,
    capabilityVersion: share.capability_version,
    expiresAt,
  }, env.SESSION_KEY);
  const headers = new Headers({
    location: '/viewer',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  headers.append('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`);
  return new Response(null, { status: 303, headers });
}

type MediaTrackRow = {
  share_id: string;
  recording_id: string;
  track_id: string;
  mime_type: string;
  bytes: number | null;
  object_key: string;
  media_asset_id: string | null;
  status: 'pending' | 'uploading' | 'complete';
  asset_id: string | null;
  drive_file_id: string | null;
  revision_id: string | null;
  asset_bytes: number | null;
  asset_mime_type: string | null;
};

async function serveMedia(
  recordingId: string,
  trackId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const session = await requireViewerSession(request, env);
  if (session instanceof Response) return session;

  const track = await env.SHARING_DB.prepare(
    `SELECT t.share_id, t.recording_id, t.track_id, t.mime_type, t.bytes, t.object_key,
            t.media_asset_id, t.status,
            a.id AS asset_id, a.drive_file_id, a.revision_id,
            a.bytes AS asset_bytes, a.mime_type AS asset_mime_type
       FROM share_tracks AS t
       LEFT JOIN media_assets AS a ON a.id = t.media_asset_id
      WHERE t.share_id = ? AND t.recording_id = ? AND t.track_id = ? AND t.status = 'complete'`,
  ).bind(session.shareId, recordingId, trackId).first<MediaTrackRow>();
  if (!track || track.bytes == null) return json({ code: 'TRACK_NOT_FOUND' }, 404);

  const requested = parseRange(request.headers.get('range'), track.bytes);
  if (requested === 'invalid') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${track.bytes}` } });
  }
  const served = boundedMediaRange(requested, track.bytes);
  const partial = requested != null || served.start !== 0 || served.end !== track.bytes - 1;
  const headers = mediaHeaders(track.mime_type, track.bytes, served.start, served.end, partial);
  if (request.method === 'HEAD') {
    return new Response(null, { status: partial ? 206 : 200, headers });
  }

  if (track.asset_id && track.drive_file_id && track.revision_id) {
    const cacheKey = mediaCacheKey(track.asset_id, track.revision_id, served.start, served.end);
    const cached = await getCachedMedia(env, cacheKey);
    if (cached) {
      return new Response(cached.body, { status: partial ? 206 : 200, headers });
    }

    const origin = await fetchDriveRevisionRange(
      env,
      track.drive_file_id,
      track.revision_id,
      served.start,
      served.end,
    );
    if (origin.status === 403 || origin.status === 404) {
      return json({ code: 'MEDIA_ORIGIN_UNAVAILABLE' }, 503, { 'cache-control': 'no-store' });
    }
    if (origin.status === 408 || origin.status === 429 || origin.status >= 500) {
      return json(
        { code: 'MEDIA_ORIGIN_TEMPORARILY_UNAVAILABLE' },
        503,
        { 'cache-control': 'no-store', 'retry-after': '5' },
      );
    }
    if (origin.status !== 206 || !origin.body) {
      return json({ code: 'MEDIA_ORIGIN_INVALID_RESPONSE' }, 502, { 'cache-control': 'no-store' });
    }

    const [viewerBody, cacheBody] = origin.body.tee();
    if (ctx) {
      ctx.waitUntil(cacheMediaRange(env, {
        cacheKey,
        assetId: track.asset_id,
        body: cacheBody,
        bytes: served.end - served.start + 1,
      }).catch(() => {}));
    } else {
      // Unit/direct callers have no Worker lifetime context. Do not let cache
      // completion delay playback; correctness always comes from Drive.
      void cacheBody.cancel().catch(() => {});
    }
    return new Response(viewerBody, { status: partial ? 206 : 200, headers });
  }

  // Migration compatibility for shares published before Drive-origin media.
  // New publications cannot reach the legacy multipart upload routes.
  const legacy = await env.SHARING_MEDIA.get(track.object_key, {
    range: { offset: served.start, length: served.end - served.start + 1 },
  });
  if (!legacy) return json({ code: 'MEDIA_NOT_FOUND' }, 404);
  return new Response(legacy.body, { status: partial ? 206 : 200, headers });
}

function boundedMediaRange(
  requested: { start: number; end: number } | null,
  total: number,
): { start: number; end: number } {
  const start = requested?.start ?? 0;
  const requestedEnd = requested?.end ?? Math.max(0, total - 1);
  return {
    start,
    end: Math.min(requestedEnd, start + MAX_MEDIA_RESPONSE_BYTES - 1),
  };
}

function mediaHeaders(
  mimeType: string,
  total: number,
  start: number,
  end: number,
  partial: boolean,
): Headers {
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-type': mimeType,
    'content-length': String(Math.max(0, end - start + 1)),
  });
  if (partial) headers.set('content-range', `bytes ${start}-${end}/${total}`);
  return headers;
}

async function requireViewerSession(request: Request, env: Env): Promise<ViewerSession | Response> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return json({ code: 'VIEWER_SESSION_REQUIRED' }, 401);
  const session = await verifyViewerSession(token, env.SESSION_KEY);
  if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return json({ code: 'VIEWER_SESSION_EXPIRED' }, 401);
  }

  const share = await getShare(env.SHARING_DB, session.shareId);
  if (!share || share.status !== 'active' || share.capability_version !== session.capabilityVersion) {
    return json({ code: 'SHARE_REVOKED' }, 410);
  }
  return session;
}
