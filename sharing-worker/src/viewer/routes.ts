import {
  cookieValue,
  signViewerSession,
  verifyViewerSession,
  viewerSessionTtl,
  type ViewerSession,
} from '../auth/capability';
import { sha256Base64Url } from '../auth/crypto';
import { parseRange } from '../http/range';
import { json } from '../http/responses';
import { getShare, type ShareRow, type TrackRow } from '../shares/ShareRepository';
import { viewerAppScript } from './appAsset';
import { viewerShell } from './shell';

const SESSION_COOKIE = '__Host-share_session';

export async function routeViewerRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
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
    return serveMedia(decodeURIComponent(mediaMatch[1]), decodeURIComponent(mediaMatch[2]), request, env);
  }

  return null;
}

async function openCapability(encodedCapability: string, request: Request, env: Env): Promise<Response> {
  const capability = decodeURIComponent(encodedCapability);
  const capabilityHash = await sha256Base64Url(capability);
  const share = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version,
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

async function serveMedia(recordingId: string, trackId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireViewerSession(request, env);
  if (session instanceof Response) return session;

  const track = await env.SHARING_DB.prepare(
    `SELECT share_id, recording_id, track_id, mime_type, bytes, object_key, status
       FROM share_tracks
      WHERE share_id = ? AND recording_id = ? AND track_id = ? AND status = 'complete'`,
  ).bind(session.shareId, recordingId, trackId).first<TrackRow>();
  if (!track || track.bytes == null) return json({ code: 'TRACK_NOT_FOUND' }, 404);

  const range = parseRange(request.headers.get('range'), track.bytes);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${track.bytes}` } });
  }

  const object = await env.SHARING_MEDIA.get(
    track.object_key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  );
  if (!object) return json({ code: 'MEDIA_NOT_FOUND' }, 404);

  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-type': track.mime_type,
    'content-length': String(range ? range.end - range.start + 1 : track.bytes),
    etag: object.httpEtag,
  });
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${track.bytes}`);

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: range ? 206 : 200,
    headers,
  });
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
