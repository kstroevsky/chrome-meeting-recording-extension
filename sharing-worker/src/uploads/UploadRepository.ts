import { json } from '../http/responses';

export type UploadRow = {
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

export type UploadPartRow = {
  part_number: number;
  byte_offset: number;
  bytes: number;
  etag: string;
};

export async function getOwnedUpload(db: D1Database, uploadId: string, ownerId: string): Promise<UploadRow | null> {
  return db.prepare(
    `SELECT u.id, u.share_id, u.recording_id, u.track_id, u.r2_upload_id, u.object_key, u.bytes,
            u.chunk_size, u.offset, u.status
       FROM share_uploads u
       JOIN shares s ON s.id = u.share_id
      WHERE u.id = ? AND s.owner_id = ?`,
  ).bind(uploadId, ownerId).first<UploadRow>();
}

export async function markUploadComplete(upload: UploadRow, env: Env): Promise<void> {
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

export async function recoverCompletedObject(upload: UploadRow, env: Env): Promise<boolean> {
  const object = await env.SHARING_MEDIA.head(upload.object_key).catch(() => null);
  if (!object || object.size !== upload.bytes) return false;
  await markUploadComplete(upload, env);
  return true;
}

export async function abandonUpload(upload: UploadRow, env: Env): Promise<void> {
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

export function uploadSessionGone(): Response {
  return json({ code: 'UPLOAD_SESSION_GONE', message: 'Multipart upload session no longer exists' }, 410);
}

export function isMultipartSessionGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('multipart') && (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('no such upload') ||
    message.includes('invalid upload')
  );
}
