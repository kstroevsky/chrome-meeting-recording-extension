import {
  canonicalizeManifest,
  canonicalizeStoredManifest,
} from './shares/manifestSchema';

const CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_COOKIE = '__Host-share_session';
const encoder = new TextEncoder();

type ShareRow = {
  id: string;
  status: 'draft' | 'uploading' | 'active' | 'revoked';
  manifest_json: string;
  capability_hash: string | null;
  capability_version: number;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  revoked_at: number | null;
};

type TrackRow = {
  share_id: string;
  recording_id: string;
  track_id: string;
  mime_type: string;
  bytes: number | null;
  object_key: string;
  status: 'pending' | 'uploading' | 'complete';
};

type UploadRow = {
  id: string;
  share_id: string;
  recording_id: string;
  track_id: string;
  r2_upload_id: string;
  object_key: string;
  bytes: number;
  chunk_size: number;
  offset: number;
  status: 'uploading' | 'completed' | 'abandoned';
};

type UploadPartRow = {
  part_number: number;
  byte_offset: number;
  bytes: number;
  etag: string;
};

type ViewerSession = {
  shareId: string;
  capabilityVersion: number;
  expiresAt: number;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('sharing worker request failed', error);
      return json({ code: 'INTERNAL_ERROR', message: 'Unexpected sharing service error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ownerRoute = isOwnerRoute(url.pathname);

  if (ownerRoute && request.method === 'OPTIONS') {
    return ownerCorsPreflight(request, env);
  }

  if (ownerRoute) {
    const denied = await authorizeOwner(request, env);
    if (denied) return withOwnerCors(denied, request, env);
    const response = await routeOwner(request, env, url);
    return withOwnerCors(response, request, env);
  }

  const capabilityMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
  if (capabilityMatch && request.method === 'GET') {
    return openCapability(capabilityMatch[1], request, env);
  }

  if (url.pathname === '/viewer' && request.method === 'GET') {
    const session = await requireViewerSession(request, env);
    if (session instanceof Response) return session;
    return viewerShell();
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

  return json({ code: 'NOT_FOUND' }, 404);
}

async function routeOwner(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/shares' && request.method === 'GET') {
    return listShares(request, env);
  }

  const shareMatch = /^\/api\/shares\/([^/]+)$/.exec(url.pathname);
  if (shareMatch) {
    const shareId = decodeURIComponent(shareMatch[1]);
    if (request.method === 'PUT') return putShare(shareId, request, env);
    if (request.method === 'GET') return getShareResponse(shareId, request, env);
    if (request.method === 'DELETE') return revokeShare(shareId, env);
  }

  const finalizeMatch = /^\/api\/shares\/([^/]+)\/finalize$/.exec(url.pathname);
  if (finalizeMatch && request.method === 'POST') {
    return finalizeShare(decodeURIComponent(finalizeMatch[1]), request, env);
  }

  const beginMatch = /^\/api\/shares\/([^/]+)\/recordings\/([^/]+)\/tracks\/([^/]+)\/uploads$/.exec(url.pathname);
  if (beginMatch && request.method === 'POST') {
    return beginUpload(
      decodeURIComponent(beginMatch[1]),
      decodeURIComponent(beginMatch[2]),
      decodeURIComponent(beginMatch[3]),
      request,
      env,
    );
  }

  const chunkMatch = /^\/api\/share-uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (chunkMatch && request.method === 'PUT') {
    return uploadChunk(decodeURIComponent(chunkMatch[1]), Number(chunkMatch[2]), request, env);
  }

  const completeMatch = /^\/api\/share-uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (completeMatch && request.method === 'POST') {
    return completeUpload(decodeURIComponent(completeMatch[1]), request, env);
  }

  return json({ code: 'NOT_FOUND' }, 404);
}

async function putShare(shareId: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const manifest = canonicalizeManifest(body, shareId);
  if (!manifest) return json({ code: 'INVALID_MANIFEST' }, 400);

  const manifestJson = JSON.stringify(manifest);
  const existing = await getShare(env.SHARING_DB, shareId);
  if (existing) {
    const existingManifest = canonicalizeStoredManifest(existing.manifest_json, shareId);
    if (!existingManifest || JSON.stringify(existingManifest) !== manifestJson) {
      return json({ code: 'SHARE_ID_CONFLICT', message: 'Share id already belongs to another snapshot' }, 409);
    }
    if (existing.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);
    return new Response(null, { status: 200 });
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.SHARING_DB.prepare(
      `INSERT INTO shares (id, status, manifest_json, created_at, updated_at)
       VALUES (?, 'draft', ?, ?, ?)`,
    ).bind(shareId, manifestJson, now, now),
  ];

  for (const recording of manifest.recordings) {
    for (const track of recording.tracks) {
      statements.push(
        env.SHARING_DB.prepare(
          `INSERT INTO share_tracks
             (share_id, recording_id, track_id, mime_type, bytes, object_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        ).bind(
          shareId,
          recording.id,
          track.id,
          track.mimeType,
          track.bytes ?? null,
          mediaObjectKey(shareId, recording.id, track.id),
        ),
      );
    }
  }

  await env.SHARING_DB.batch(statements);
  return new Response(null, { status: 201 });
}

async function listShares(request: Request, env: Env): Promise<Response> {
  const result = await env.SHARING_DB.prepare(
    `SELECT id, status, manifest_json, capability_hash, capability_version,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares ORDER BY created_at DESC`,
  ).all<ShareRow>();

  const shares = await Promise.all(result.results.map((share) => ownerShareView(share, request, env)));
  return json({ shares });
}

async function getShareResponse(shareId: string, request: Request, env: Env): Promise<Response> {
  const share = await getShare(env.SHARING_DB, shareId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  return json(await ownerShareView(share, request, env));
}

async function ownerShareView(share: ShareRow, request: Request, env: Env): Promise<Record<string, unknown>> {
  return {
    id: share.id,
    status: share.status,
    manifest: JSON.parse(share.manifest_json),
    createdAt: share.created_at,
    updatedAt: share.updated_at,
    ...(share.finalized_at != null ? { finalizedAt: share.finalized_at } : {}),
    ...(share.revoked_at != null ? { revokedAt: share.revoked_at } : {}),
    ...(share.status === 'active' ? { shareUrl: await shareUrl(share, request, env) } : {}),
  };
}

async function revokeShare(shareId: string, env: Env): Promise<Response> {
  const share = await getShare(env.SHARING_DB, shareId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'revoked') return new Response(null, { status: 204 });

  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `UPDATE shares SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, shareId),
    env.SHARING_DB.prepare(
      `UPDATE share_uploads SET status = 'abandoned', updated_at = ?
       WHERE share_id = ? AND status = 'uploading'`,
    ).bind(now, shareId),
  ]);
  return new Response(null, { status: 204 });
}

async function beginUpload(
  shareId: string,
  recordingId: string,
  trackId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await readJson(request);
  const mimeType = stringField(body, 'mimeType');
  const bytes = integerField(body, 'bytes');
  if (!mimeType || bytes == null || bytes < 0) {
    return json({ code: 'INVALID_UPLOAD', message: 'mimeType and non-negative bytes are required' }, 400);
  }

  const share = await getShare(env.SHARING_DB, shareId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'active') return json({ code: 'SHARE_ALREADY_ACTIVE' }, 409);
  if (share.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);

  const track = await env.SHARING_DB.prepare(
    `SELECT share_id, recording_id, track_id, mime_type, bytes, object_key, status
       FROM share_tracks WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
  ).bind(shareId, recordingId, trackId).first<TrackRow>();
  if (!track) return json({ code: 'TRACK_NOT_FOUND' }, 404);
  if (track.mime_type !== mimeType || (track.bytes != null && track.bytes !== bytes)) {
    return json({ code: 'TRACK_METADATA_MISMATCH' }, 409);
  }

  const existing = await env.SHARING_DB.prepare(
    `SELECT id, share_id, recording_id, track_id, r2_upload_id, object_key, bytes,
            chunk_size, offset, status
       FROM share_uploads
      WHERE share_id = ? AND recording_id = ? AND track_id = ?
        AND status IN ('uploading', 'completed')
      LIMIT 1`,
  ).bind(shareId, recordingId, trackId).first<UploadRow>();
  if (existing) {
    return json({ uploadId: existing.id, chunkSize: existing.chunk_size, offset: existing.offset });
  }

  const multipart = await env.SHARING_MEDIA.createMultipartUpload(track.object_key);
  const uploadId = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.SHARING_DB.batch([
      env.SHARING_DB.prepare(
        `INSERT INTO share_uploads
           (id, share_id, recording_id, track_id, r2_upload_id, object_key, bytes,
            chunk_size, offset, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?, ?)`,
      ).bind(
        uploadId,
        shareId,
        recordingId,
        trackId,
        multipart.uploadId,
        track.object_key,
        bytes,
        CHUNK_SIZE,
        now,
        now,
      ),
      env.SHARING_DB.prepare(
        `UPDATE share_tracks SET bytes = COALESCE(bytes, ?), status = 'uploading'
         WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
      ).bind(bytes, shareId, recordingId, trackId),
      env.SHARING_DB.prepare(
        `UPDATE shares SET status = 'uploading', updated_at = ? WHERE id = ? AND status = 'draft'`,
      ).bind(now, shareId),
    ]);
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }

  return json({ uploadId, chunkSize: CHUNK_SIZE, offset: 0 }, 201);
}

async function uploadChunk(uploadId: string, offset: number, request: Request, env: Env): Promise<Response> {
  const upload = await getUpload(env.SHARING_DB, uploadId);
  if (!upload || upload.status === 'abandoned') return uploadSessionGone();
  if (upload.status === 'completed') return new Response(null, { status: 204 });

  const range = parseContentRange(request.headers.get('content-range'));
  if (!range || range.start !== offset || range.total !== upload.bytes) {
    return json({ code: 'INVALID_CONTENT_RANGE' }, 400);
  }
  const chunkBytes = range.end - range.start + 1;
  if (chunkBytes <= 0 || chunkBytes > upload.chunk_size || range.end >= upload.bytes) {
    return json({ code: 'INVALID_CONTENT_RANGE' }, 400);
  }
  if (range.end + 1 < upload.bytes && chunkBytes !== upload.chunk_size) {
    return json({ code: 'INVALID_CHUNK_SIZE' }, 400);
  }
  if (offset % upload.chunk_size !== 0) return json({ code: 'INVALID_CHUNK_OFFSET' }, 400);

  const contentLength = request.headers.get('content-length');
  if (contentLength != null && Number(contentLength) !== chunkBytes) {
    return json({ code: 'CONTENT_LENGTH_MISMATCH' }, 400);
  }

  const committed = await env.SHARING_DB.prepare(
    `SELECT part_number, byte_offset, bytes, etag
       FROM share_upload_parts WHERE upload_id = ? AND byte_offset = ?`,
  ).bind(uploadId, offset).first<UploadPartRow>();
  if (committed) {
    if (committed.bytes !== chunkBytes) return json({ code: 'CHUNK_REPLAY_MISMATCH' }, 409);
    return new Response(null, { status: 204 });
  }

  if (upload.offset !== offset) {
    return json({ code: 'UPLOAD_OFFSET_MISMATCH', expectedOffset: upload.offset }, 409);
  }
  if (!request.body) return json({ code: 'EMPTY_CHUNK' }, 400);

  const partNumber = Math.floor(offset / upload.chunk_size) + 1;
  const multipart = env.SHARING_MEDIA.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
  let part: R2UploadedPart;
  try {
    part = await multipart.uploadPart(partNumber, request.body);
  } catch (error) {
    if (await recoverCompletedObject(upload, env)) return new Response(null, { status: 204 });
    if (isMultipartSessionGone(error)) {
      await abandonUpload(upload, env);
      return uploadSessionGone();
    }
    throw error;
  }

  const nextOffset = range.end + 1;
  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `INSERT OR REPLACE INTO share_upload_parts (upload_id, part_number, byte_offset, bytes, etag)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(uploadId, part.partNumber, offset, chunkBytes, part.etag),
    env.SHARING_DB.prepare(
      `UPDATE share_uploads SET offset = ?, updated_at = ?
       WHERE id = ? AND status = 'uploading' AND offset = ?`,
    ).bind(nextOffset, now, uploadId, offset),
  ]);

  return new Response(null, { status: 204 });
}

async function completeUpload(uploadId: string, request: Request, env: Env): Promise<Response> {
  const upload = await getUpload(env.SHARING_DB, uploadId);
  if (!upload || upload.status === 'abandoned') return uploadSessionGone();
  if (upload.status === 'completed') return new Response(null, { status: 204 });

  const body = await readJson(request);
  const totalBytes = integerField(body, 'totalBytes');
  if (totalBytes == null || totalBytes !== upload.bytes) return json({ code: 'TOTAL_BYTES_MISMATCH' }, 409);
  if (upload.offset !== upload.bytes) {
    return json({ code: 'UPLOAD_INCOMPLETE', expectedOffset: upload.offset }, 409);
  }

  const partsResult = await env.SHARING_DB.prepare(
    `SELECT part_number, byte_offset, bytes, etag
       FROM share_upload_parts WHERE upload_id = ? ORDER BY byte_offset ASC`,
  ).bind(uploadId).all<UploadPartRow>();
  const parts = partsResult.results;
  let expectedOffset = 0;
  for (const part of parts) {
    if (part.byte_offset !== expectedOffset) return json({ code: 'UPLOAD_PARTS_INCOMPLETE' }, 409);
    expectedOffset += part.bytes;
  }
  if (expectedOffset !== upload.bytes) return json({ code: 'UPLOAD_PARTS_INCOMPLETE' }, 409);

  const multipart = env.SHARING_MEDIA.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
  try {
    await multipart.complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
  } catch (error) {
    if (!(await recoverCompletedObject(upload, env))) {
      if (isMultipartSessionGone(error)) {
        await abandonUpload(upload, env);
        return uploadSessionGone();
      }
      throw error;
    }
  }

  await markUploadComplete(upload, env);
  return new Response(null, { status: 204 });
}

async function finalizeShare(shareId: string, request: Request, env: Env): Promise<Response> {
  const share = await getShare(env.SHARING_DB, shareId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);
  if (share.status === 'active') return json({ shareUrl: await shareUrl(share, request, env) });

  const pending = await env.SHARING_DB.prepare(
    `SELECT COUNT(*) AS count FROM share_tracks WHERE share_id = ? AND status != 'complete'`,
  ).bind(shareId).first<{ count: number }>();
  if (!pending || pending.count !== 0) return json({ code: 'SHARE_UPLOADS_INCOMPLETE' }, 409);

  const capability = await deriveCapability(share.id, share.capability_version, env.CAPABILITY_KEY);
  const capabilityHash = await sha256Base64Url(capability);
  const now = Date.now();
  await env.SHARING_DB.prepare(
    `UPDATE shares
        SET status = 'active', capability_hash = ?, finalized_at = COALESCE(finalized_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('draft', 'uploading')`,
  ).bind(capabilityHash, now, now, share.id).run();

  const active = await getShare(env.SHARING_DB, shareId);
  if (!active || active.status !== 'active') return json({ code: 'FINALIZE_CONFLICT' }, 409);
  return json({ shareUrl: capabilityUrl(request, capability) });
}

async function openCapability(encodedCapability: string, request: Request, env: Env): Promise<Response> {
  const capability = decodeURIComponent(encodedCapability);
  const capabilityHash = await sha256Base64Url(capability);
  const share = await env.SHARING_DB.prepare(
    `SELECT id, status, manifest_json, capability_hash, capability_version,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE capability_hash = ? LIMIT 1`,
  ).bind(capabilityHash).first<ShareRow>();
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status !== 'active') return json({ code: 'SHARE_REVOKED' }, 410);

  const expiresAt = Math.floor(Date.now() / 1000) + viewerSessionTtl(env);
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
  headers.append('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${viewerSessionTtl(env)}`);
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

async function getShare(db: D1Database, shareId: string): Promise<ShareRow | null> {
  return db.prepare(
    `SELECT id, status, manifest_json, capability_hash, capability_version,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE id = ?`,
  ).bind(shareId).first<ShareRow>();
}

async function getUpload(db: D1Database, uploadId: string): Promise<UploadRow | null> {
  return db.prepare(
    `SELECT id, share_id, recording_id, track_id, r2_upload_id, object_key, bytes,
            chunk_size, offset, status
       FROM share_uploads WHERE id = ?`,
  ).bind(uploadId).first<UploadRow>();
}

async function markUploadComplete(upload: UploadRow, env: Env): Promise<void> {
  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `UPDATE share_uploads SET status = 'completed', offset = bytes, updated_at = ? WHERE id = ?`,
    ).bind(now, upload.id),
    env.SHARING_DB.prepare(
      `UPDATE share_tracks SET status = 'complete', bytes = ?
       WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
    ).bind(upload.bytes, upload.share_id, upload.recording_id, upload.track_id),
  ]);
}

async function recoverCompletedObject(upload: UploadRow, env: Env): Promise<boolean> {
  const object = await env.SHARING_MEDIA.head(upload.object_key).catch(() => null);
  if (!object || object.size !== upload.bytes) return false;
  await markUploadComplete(upload, env);
  return true;
}

async function abandonUpload(upload: UploadRow, env: Env): Promise<void> {
  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `UPDATE share_uploads SET status = 'abandoned', updated_at = ? WHERE id = ?`,
    ).bind(now, upload.id),
    env.SHARING_DB.prepare(
      `UPDATE share_tracks SET status = 'pending'
       WHERE share_id = ? AND recording_id = ? AND track_id = ? AND status != 'complete'`,
    ).bind(upload.share_id, upload.recording_id, upload.track_id),
  ]);
}

function uploadSessionGone(): Response {
  return json({ code: 'UPLOAD_SESSION_GONE', message: 'Multipart upload session no longer exists' }, 410);
}

function isMultipartSessionGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('multipart') && (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('no such upload') ||
    message.includes('invalid upload')
  );
}

async function authorizeOwner(request: Request, env: Env): Promise<Response | null> {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins(env).has(origin)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return json({ code: 'OWNER_AUTH_REQUIRED' }, 401);
  const supplied = header.slice('Bearer '.length);
  if (!(await secureEqual(supplied, env.OWNER_API_TOKEN, env.SESSION_KEY))) {
    return json({ code: 'OWNER_AUTH_INVALID' }, 401);
  }
  return null;
}

function isOwnerRoute(pathname: string): boolean {
  return pathname === '/api/shares' || pathname.startsWith('/api/shares/') || pathname.startsWith('/api/share-uploads/');
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_EXTENSION_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean));
}

function ownerCorsPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, content-range',
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  });
}

function withOwnerCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function secureEqual(left: string, right: string, comparisonSecret: string): Promise<boolean> {
  const key = await importHmacKey(comparisonSecret, ['sign', 'verify']);
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(right));
  return crypto.subtle.verify('HMAC', key, expected, encoder.encode(left));
}

async function deriveCapability(shareId: string, version: number, secret: string): Promise<string> {
  return hmacBase64Url(secret, `share:${shareId}:v${version}`);
}

async function shareUrl(share: ShareRow, request: Request, env: Env): Promise<string> {
  const capability = await deriveCapability(share.id, share.capability_version, env.CAPABILITY_KEY);
  return capabilityUrl(request, capability);
}

function capabilityUrl(request: Request, capability: string): string {
  const url = new URL(request.url);
  return `${url.origin}/s/${encodeURIComponent(capability)}`;
}

async function signViewerSession(session: ViewerSession, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(session)));
  const signature = await hmacBase64Url(secret, payload);
  return `${payload}.${signature}`;
}

async function verifyViewerSession(token: string, secret: string): Promise<ViewerSession | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra != null) return null;
  const expected = await hmacBase64Url(secret, payload);
  if (!(await secureEqual(signature, expected, secret))) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<string, unknown>;
    if (
      typeof parsed.shareId !== 'string' ||
      !Number.isInteger(parsed.capabilityVersion) ||
      !Number.isInteger(parsed.expiresAt)
    ) return null;
    return {
      shareId: parsed.shareId,
      capabilityVersion: Number(parsed.capabilityVersion),
      expiresAt: Number(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function viewerSessionTtl(env: Env): number {
  const parsed = Number(env.VIEWER_SESSION_TTL_SECONDS);
  return Number.isInteger(parsed) && parsed >= 60 ? Math.min(parsed, 86_400) : 43_200;
}

function mediaObjectKey(shareId: string, recordingId: string, trackId: string): string {
  return `shares/${encodeURIComponent(shareId)}/recordings/${encodeURIComponent(recordingId)}/tracks/${encodeURIComponent(trackId)}`;
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total < 0) return null;
  return { start, end, total };
}

function parseRange(value: string | null, total: number): { start: number; end: number } | null | 'invalid' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || total <= 0) return 'invalid';

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= total || requestedEnd < start) {
    return 'invalid';
  }
  return { start, end: Math.min(requestedEnd, total - 1) };
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function integerField(value: unknown, field: string): number | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : null;
}

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', headers.get('cache-control') ?? 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

function viewerShell(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Shared recording</title>
</head>
<body>
  <main>
    <h1>Shared recording</h1>
    <p>This intentionally minimal viewer proves capability exchange, protected metadata, ranged media, and revocation.</p>
    <pre id="manifest">Loading…</pre>
  </main>
  <script type="module">
    const response = await fetch('/viewer/manifest', { cache: 'no-store' });
    document.querySelector('#manifest').textContent = response.ok
      ? JSON.stringify(await response.json(), null, 2)
      : 'This share is no longer available.';
  </script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
