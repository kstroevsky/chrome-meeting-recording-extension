CREATE TABLE drive_cleanup_candidates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('revoke', 'delete')),
  kind TEXT NOT NULL CHECK (kind IN ('permission', 'revision')),
  drive_file_id TEXT NOT NULL,
  revision_id TEXT NOT NULL DEFAULT '',
  permission_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (share_id, action, kind, drive_file_id, revision_id)
);

CREATE INDEX drive_cleanup_candidates_owner_share
  ON drive_cleanup_candidates(owner_id, share_id, action);

CREATE TABLE drive_cleanup_leases (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  holder_owner_id TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('permission', 'revision')),
  drive_file_id TEXT NOT NULL,
  revision_id TEXT NOT NULL DEFAULT '',
  permission_id TEXT,
  lease_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, drive_file_id, revision_id),
  FOREIGN KEY (candidate_id) REFERENCES drive_cleanup_candidates(id) ON DELETE CASCADE
);

CREATE INDEX drive_cleanup_leases_expiry ON drive_cleanup_leases(expires_at);
