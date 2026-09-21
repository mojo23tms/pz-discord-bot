CREATE TABLE IF NOT EXISTS server_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  discord_user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restart_cycles (
  restart_at INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  warn_60_at INTEGER,
  warn_30_at INTEGER,
  warn_5_at INTEGER,
  warn_1_at INTEGER,
  save_at INTEGER,
  outage_seen_at INTEGER,
  recovered_at INTEGER,
  failure_alert_at INTEGER,
  failure_alert_message_id TEXT
);

CREATE TABLE IF NOT EXISTS workshop_items (
  workshop_id TEXT PRIMARY KEY,
  title TEXT,
  steam_updated_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  pending_since INTEGER,
  pending_steam_updated_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_workshop_items_pending
  ON workshop_items (active, pending_steam_updated_at);
