import { isMultipartSessionGone } from '../uploads/UploadRepository';
import { deleteAssetCache } from '../cache/mediaCache';
import type { ShareRow } from './ShareRepository';
import { enqueueDriveCleanupCandidates } from './driveCleanup';

type CleanupUploadRow = {
  id: string;
  r2_upload_id: string;
  object_key: string;
  status: 'uploading' | 'completed' | 'abandoned';
};

type CleanupTrackRow = { object_key: string; media_asset_id: string | null };
type CleanupAssetRow = { id: string };

/**
 * Permanently removes one already-authorized share. Active shares must be
 * revoked by the caller first; drafts and abandoned publications can be
 * removed directly by scheduled cleanup.
 */
export async function deletePublishedShare(env: Env, share: ShareRow): Promise<void> {
  await enqueueDriveCleanupCandidates(env, share.owner_id, share.id, 'delete');
  const assets = await env.SHARING_DB.prepare(
    'SELECT id FROM media_assets WHERE share_id = ?',
  ).bind(share.id).all<CleanupAssetRow>();
  await deleteAssetCache(env, assets.results.map((asset) => asset.id));

  const uploads = await env.SHARING_DB.prepare(
    `SELECT id, r2_upload_id, object_key, status
       FROM share_uploads WHERE share_id = ?`,
  ).bind(share.id).all<CleanupUploadRow>();

  for (const upload of uploads.results) {
    if (upload.status === 'completed') continue;
    const multipart = env.SHARING_MEDIA.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
    try {
      await multipart.abort();
    } catch (error) {
      if (!isMultipartSessionGone(error)) throw error;
    }
  }

  const tracks = await env.SHARING_DB.prepare(
    `SELECT object_key, media_asset_id FROM share_tracks WHERE share_id = ?`,
  ).bind(share.id).all<CleanupTrackRow>();
  // Permanent R2 objects exist only for publications created by the legacy
  // multipart path. New Drive-origin tracks have no object at object_key.
  const objectKeys = [...new Set(
    tracks.results.filter((track) => !track.media_asset_id).map((track) => track.object_key),
  )];
  if (objectKeys.length) await env.SHARING_MEDIA.delete(objectKeys);

  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `DELETE FROM share_upload_parts
        WHERE upload_id IN (SELECT id FROM share_uploads WHERE share_id = ?)`,
    ).bind(share.id),
    env.SHARING_DB.prepare('DELETE FROM share_uploads WHERE share_id = ?').bind(share.id),
    env.SHARING_DB.prepare('DELETE FROM media_assets WHERE share_id = ?').bind(share.id),
    env.SHARING_DB.prepare('DELETE FROM share_tracks WHERE share_id = ?').bind(share.id),
    env.SHARING_DB.prepare('DELETE FROM shares WHERE id = ?').bind(share.id),
  ]);
}
