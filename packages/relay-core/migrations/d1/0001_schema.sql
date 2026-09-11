CREATE TABLE pairing_channels (
  pairing_id TEXT PRIMARY KEY,
  pairing_code_hash TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  runtime_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  daemon_token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  machine_name TEXT NOT NULL DEFAULT '',
  workspace_name TEXT NOT NULL DEFAULT '',
  agents_json TEXT NOT NULL DEFAULT '[]',
  installable_agents_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX pairing_channels_expires_at
  ON pairing_channels(expires_at);

CREATE INDEX pairing_channels_project
  ON pairing_channels(tenant_id, project_id, channel_id);

CREATE TABLE channel_host_credentials (
  credential_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  authority TEXT NOT NULL CHECK (authority IN ('owner', 'linked')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  source_grant_id TEXT UNIQUE
);

CREATE INDEX channel_host_credentials_channel
  ON channel_host_credentials(channel_id, authority, revoked_at, created_at);

CREATE TABLE channel_access_grants (
  grant_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_by_credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_credential_id TEXT
);

CREATE INDEX channel_access_grants_channel
  ON channel_access_grants(channel_id, created_at);

CREATE TABLE session_directory (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready', 'deleting', 'deleted')),
  updated_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, session_id)
);

CREATE INDEX session_directory_page
  ON session_directory(tenant_id, project_id, updated_at DESC, session_id DESC);

CREATE INDEX session_directory_runtime
  ON session_directory(tenant_id, project_id, runtime_id, lifecycle);

CREATE TABLE session_quota_reservations (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, project_id, session_id)
);

CREATE INDEX session_quota_tenant
  ON session_quota_reservations(tenant_id);

CREATE INDEX session_quota_project
  ON session_quota_reservations(tenant_id, project_id);
