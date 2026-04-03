CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_suffix TEXT NOT NULL,
  model TEXT NOT NULL,
  call_type TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_suffix ON api_key_usage(api_key_suffix);
CREATE INDEX IF NOT EXISTS idx_usage_created ON api_key_usage(created_at);

CREATE TABLE IF NOT EXISTS api_key_cooldowns (
  api_key_suffix TEXT PRIMARY KEY,
  cooldown_until INTEGER NOT NULL,
  reason TEXT DEFAULT '429',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_history(session_id);

CREATE TABLE IF NOT EXISTS car_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
