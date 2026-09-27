-- One owner per Drive file. The shared service account can read every
-- published file, so its readability proves nothing about who owns a file;
-- this binding is what stops one owner from registering another owner's
-- Drive revision into their own share. The first publisher of a file owns it.
CREATE TABLE drive_file_owners (
  drive_file_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX media_assets_drive_file ON media_assets(drive_file_id);
CREATE INDEX drive_cleanup_candidates_drive_file ON drive_cleanup_candidates(drive_file_id);

-- Existing registrations: the earliest one for each file wins. A file that
-- appears under more than one owner is listed by the query in
-- docs/sharing-operations.md ("Drive file owner binding") for review.
INSERT OR IGNORE INTO drive_file_owners (drive_file_id, owner_id, created_at, updated_at)
SELECT a.drive_file_id, s.owner_id, a.created_at, a.updated_at
  FROM media_assets AS a
  JOIN shares AS s ON s.id = a.share_id
 ORDER BY a.created_at ASC, a.id ASC;
