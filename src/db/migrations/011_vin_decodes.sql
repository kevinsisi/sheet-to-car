CREATE TABLE IF NOT EXISTS vin_decodes (
  vin TEXT PRIMARY KEY,
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  engine_cylinders TEXT NOT NULL DEFAULT '',
  engine_displacement_l TEXT NOT NULL DEFAULT '',
  engine_model TEXT NOT NULL DEFAULT '',
  fuel_type TEXT NOT NULL DEFAULT '',
  horsepower TEXT NOT NULL DEFAULT '',
  drive_type TEXT NOT NULL DEFAULT '',
  body_class TEXT NOT NULL DEFAULT '',
  doors TEXT NOT NULL DEFAULT '',
  transmission_style TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  decoded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
