ALTER TABLE share_tracks ADD COLUMN media_asset_id TEXT;

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  mime_type TEXT NOT NULL,
  md5_checksum TEXT,
  permission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (share_id, recording_id, track_id),
  FOREIGN KEY (share_id, recording_id, track_id)
    REFERENCES share_tracks(share_id, recording_id, track_id)
    ON DELETE CASCADE
);

CREATE INDEX media_assets_share ON media_assets(share_id);
CREATE INDEX share_tracks_media_asset ON share_tracks(media_asset_id);

CREATE TABLE media_cache_entries (
  cache_key TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  cached_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE CASCADE
);

CREATE INDEX media_cache_expiry ON media_cache_entries(expires_at);
CREATE INDEX media_cache_asset ON media_cache_entries(asset_id);

CREATE TABLE media_cache_budget (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  live_bytes INTEGER NOT NULL DEFAULT 0 CHECK (live_bytes >= 0),
  day INTEGER NOT NULL,
  puts_today INTEGER NOT NULL DEFAULT 0 CHECK (puts_today >= 0)
);

INSERT INTO media_cache_budget (singleton, live_bytes, day, puts_today)
VALUES (1, 0, 0, 0);
