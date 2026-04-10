CREATE TABLE IF NOT EXISTS vehicle_confirmed_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item, source, field, value),
  FOREIGN KEY (item) REFERENCES cars(item) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vehicle_confirmed_features_item ON vehicle_confirmed_features(item);
