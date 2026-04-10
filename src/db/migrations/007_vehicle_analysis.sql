CREATE TABLE IF NOT EXISTS vehicle_analysis (
  item TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  baseline_findings_json TEXT NOT NULL DEFAULT '[]',
  review_hints_json TEXT NOT NULL DEFAULT '[]',
  recommended_photos_json TEXT NOT NULL DEFAULT '[]',
  suggested_intro_lines_json TEXT NOT NULL DEFAULT '[]',
  summary_text TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item) REFERENCES cars(item) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vehicle_analysis_status ON vehicle_analysis(status);
CREATE INDEX IF NOT EXISTS idx_vehicle_analysis_updated_at ON vehicle_analysis(updated_at DESC);
