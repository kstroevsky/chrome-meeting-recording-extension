CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'uploading', 'active', 'revoked')),
  manifest_json TEXT NOT NULL,
  capability_hash TEXT UNIQUE,
  capability_version INTEGER NOT NULL DEFAULT 1 CHECK (capability_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finalized_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE share_tracks (
  share_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'complete')),
  PRIMARY KEY (share_id, recording_id, track_id),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE TABLE share_uploads (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
  offset INTEGER NOT NULL DEFAULT 0 CHECK (offset >= 0),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'completed', 'abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (share_id, recording_id, track_id)
    REFERENCES share_tracks(share_id, recording_id, track_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX share_uploads_active_track
  ON share_uploads(share_id, recording_id, track_id)
  WHERE status IN ('uploading', 'completed');

CREATE TABLE share_upload_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  etag TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number),
  FOREIGN KEY (upload_id) REFERENCES share_uploads(id) ON DELETE CASCADE
);

CREATE INDEX shares_status_updated ON shares(status, updated_at DESC);
CREATE INDEX tracks_share_status ON share_tracks(share_id, status);
CREATE INDEX uploads_track_status ON share_uploads(share_id, recording_id, track_id, status);
