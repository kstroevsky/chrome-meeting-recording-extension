export type ShareRow = {
  id: string;
  owner_id: string;
  status: 'draft' | 'uploading' | 'active' | 'revoked';
  manifest_json: string;
  capability_hash: string | null;
  capability_version: number;
  capability_key_id: string;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  revoked_at: number | null;
};

export type TrackRow = {
  share_id: string;
  recording_id: string;
  track_id: string;
  mime_type: string;
  bytes: number | null;
  object_key: string;
  status: 'pending' | 'uploading' | 'complete';
};

export async function getShare(db: D1Database, shareId: string): Promise<ShareRow | null> {
  return db.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version, capability_key_id,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE id = ?`,
  ).bind(shareId).first<ShareRow>();
}

export async function getOwnedShare(db: D1Database, shareId: string, ownerId: string): Promise<ShareRow | null> {
  return db.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version, capability_key_id,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE id = ? AND owner_id = ?`,
  ).bind(shareId, ownerId).first<ShareRow>();
}

export function mediaObjectKey(shareId: string, recordingId: string, trackId: string): string {
  return `shares/${encodeURIComponent(shareId)}/recordings/${encodeURIComponent(recordingId)}/tracks/${encodeURIComponent(trackId)}`;
}
