CREATE TABLE IF NOT EXISTS owner_overrides (
  item TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_owner_overrides_updated_at ON owner_overrides(updated_at);
