ALTER TABLE shares ADD COLUMN recording_titles_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE shares ADD COLUMN recording_count INTEGER NOT NULL DEFAULT 0 CHECK (recording_count >= 0);
ALTER TABLE shares ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0 CHECK (track_count >= 0);
ALTER TABLE shares ADD COLUMN total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0);

UPDATE shares
   SET recording_titles_json = COALESCE((
         SELECT json_group_array(json_extract(recording.value, '$.title'))
           FROM json_each(shares.manifest_json, '$.recordings') AS recording
       ), '[]'),
       recording_count = COALESCE(json_array_length(manifest_json, '$.recordings'), 0),
       track_count = (
         SELECT COUNT(*) FROM share_tracks WHERE share_tracks.share_id = shares.id
       ),
       total_bytes = CASE
         WHEN EXISTS (
           SELECT 1 FROM share_tracks
            WHERE share_tracks.share_id = shares.id AND share_tracks.bytes IS NULL
         ) THEN NULL
         ELSE COALESCE((
           SELECT SUM(bytes) FROM share_tracks WHERE share_tracks.share_id = shares.id
         ), 0)
       END;

CREATE INDEX shares_owner_created_id ON shares(owner_id, created_at DESC, id DESC);
