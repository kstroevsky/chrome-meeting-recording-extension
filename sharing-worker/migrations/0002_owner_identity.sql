ALTER TABLE shares ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

CREATE INDEX shares_owner_created ON shares(owner_id, created_at DESC);
