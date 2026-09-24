ALTER TABLE shares ADD COLUMN capability_key_id TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE owner_rate_limits (
  owner_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

CREATE INDEX shares_owner_status ON shares(owner_id, status);
