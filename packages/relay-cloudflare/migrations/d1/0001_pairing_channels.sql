CREATE TABLE IF NOT EXISTS pairing_channels (
  pairing_id TEXT PRIMARY KEY,
  pairing_code_hash TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  host_token_hash TEXT NOT NULL,
  daemon_token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  machine_name TEXT NOT NULL DEFAULT '',
  workspace_name TEXT NOT NULL DEFAULT '',
  agents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS pairing_channels_expires_at
  ON pairing_channels(expires_at);
