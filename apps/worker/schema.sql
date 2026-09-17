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
