CREATE TABLE IF NOT EXISTS vehicle_photo_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  image_paths_json TEXT NOT NULL DEFAULT '[]',
  findings_json TEXT NOT NULL DEFAULT '[]',
  review_hints_json TEXT NOT NULL DEFAULT '[]',
  suggested_copy_lines_json TEXT NOT NULL DEFAULT '[]',
  summary_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item) REFERENCES cars(item) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vehicle_photo_analysis_item_created ON vehicle_photo_analysis(item, created_at DESC);
