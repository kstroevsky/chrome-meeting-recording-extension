import { integerField, json, readBodyBytes, readJson, stringField } from '../http/responses';
import { sharingMetric } from '../observability';
import { parseContentRange } from '../http/range';
import { ensureAdditionalStorageQuota } from '../security/limits';
import { getOwnedShare, type TrackRow } from '../shares/ShareRepository';
import { SHARING_CONTRACT_LIMITS } from '../../../src/shared/sharingContract';
import {
  abandonUpload,
  getOwnedUpload,
  isMultipartSessionGone,
  markUploadComplete,
  recoverCompletedObject,
  uploadSessionGone,
  type UploadPartRow,
  type UploadRow,
} from './UploadRepository';

const CHUNK_SIZE = 8 * 1024 * 1024;

export async function routeUploadOwnerRequest(
  request: Request,
  env: Env,
  url: URL,
  ownerId: string,
): Promise<Response | null> {
  const beginMatch = /^\/api\/shares\/([^/]+)\/recordings\/([^/]+)\/tracks\/([^/]+)\/uploads$/.exec(url.pathname);
  if (beginMatch && request.method === 'POST') {
    return beginUpload(
      decodeURIComponent(beginMatch[1]),
      decodeURIComponent(beginMatch[2]),
      decodeURIComponent(beginMatch[3]),
      request,
      env,
      ownerId,
    );
  }

  const chunkMatch = /^\/api\/share-uploads\/([^/]+)\/chunks\/(\d+)$/.exec(url.pathname);
  if (chunkMatch && request.method === 'PUT') {
    return uploadChunk(decodeURIComponent(chunkMatch[1]), Number(chunkMatch[2]), request, env, ownerId);
  }

  const completeMatch = /^\/api\/share-uploads\/([^/]+)\/complete$/.exec(url.pathname);
  if (completeMatch && request.method === 'POST') {
    return completeUpload(decodeURIComponent(completeMatch[1]), request, env, ownerId);
  }

  return null;
}

async function beginUpload(
  shareId: string,
  recordingId: string,
  trackId: string,
  request: Request,
  env: Env,
  ownerId: string,
): Promise<Response> {
  const body = await readJson(request);
  const mimeType = stringField(body, 'mimeType');
  const bytes = integerField(body, 'bytes');
  if (
    !mimeType || mimeType.length > SHARING_CONTRACT_LIMITS.mimeTypeChars
    || bytes == null || bytes < 0 || bytes > SHARING_CONTRACT_LIMITS.publishedBytes
  ) {
    return json({ code: 'INVALID_UPLOAD', message: 'mimeType and non-negative bytes are required' }, 400);
  }

  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
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

  if (track.bytes == null) {
    const shareBytes = await env.SHARING_DB.prepare(
      'SELECT COALESCE(SUM(bytes), 0) AS bytes FROM share_tracks WHERE share_id = ?',
    ).bind(shareId).first<{ bytes: number }>();
    if (Number(shareBytes?.bytes ?? 0) + bytes > SHARING_CONTRACT_LIMITS.publishedBytes) {
      return json({ code: 'SHARE_STORAGE_LIMIT_EXCEEDED' }, 413);
    }
    const quota = await ensureAdditionalStorageQuota(env, ownerId, bytes);
    if (quota) return quota;
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

async function uploadChunk(uploadId: string, offset: number, request: Request, env: Env, ownerId: string): Promise<Response> {
  const upload = await getOwnedUpload(env.SHARING_DB, uploadId, ownerId);
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
    sharingMetric('sharing_upload_chunk_replayed', { bytes: chunkBytes });
    return new Response(null, { status: 204 });
  }

  if (upload.offset !== offset) {
    return json({ code: 'UPLOAD_OFFSET_MISMATCH', expectedOffset: upload.offset }, 409);
  }
  if (!request.body) return json({ code: 'EMPTY_CHUNK' }, 400);

  const body = await readBodyBytes(request, chunkBytes);
  if (body.byteLength !== chunkBytes) return json({ code: 'CONTENT_LENGTH_MISMATCH' }, 400);

  const partNumber = Math.floor(offset / upload.chunk_size) + 1;
  const multipart = env.SHARING_MEDIA.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
  let part: R2UploadedPart;
  try {
    part = await multipart.uploadPart(partNumber, body);
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

async function completeUpload(uploadId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const upload = await getOwnedUpload(env.SHARING_DB, uploadId, ownerId);
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
  sharingMetric('sharing_storage_committed', { bytes: upload.bytes });
  return new Response(null, { status: 204 });
}
