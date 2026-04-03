-- Car copy (文案) storage
CREATE TABLE IF NOT EXISTS car_copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  platform TEXT NOT NULL,  -- '官網' | '8891' | 'Facebook'
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | '上架'
  published_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_copies_item ON car_copies(item);
CREATE INDEX IF NOT EXISTS idx_copies_status ON car_copies(status);
CREATE INDEX IF NOT EXISTS idx_copies_expires ON car_copies(expires_at);

-- User preferences / memory
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team members
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  english_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  line_id TEXT NOT NULL,
  line_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Seed team members
INSERT OR IGNORE INTO team_members (name, english_name, phone, line_id, line_url) VALUES
  ('劉小姐', 'Mita', '0976-875-679', 'mitaliu', 'https://line.me/ti/p/O06nQFoZXB'),
  ('謝先生', 'James', '0937-077-899', 'xjames', 'https://line.me/ti/p/sgIYil7fiv'),
  ('李先生', 'Roger', '0938-381-392', 'crazyroger915', 'https://line.me/ti/p/tHaeBr9lO4'),
  ('郭先生', '小郭', '0930-851-973', 'madblnc', 'https://line.me/ti/p/4KF5gZ8fGI'),
  ('林先生', 'Hank', '0912-178-095', 'hank12436', 'https://line.me/ti/p/8Oy07RcOuZ');

-- Prompt templates stored in settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('system_prompt', '', datetime('now'));
