ALTER TABLE pairing_channels RENAME TO pairing_channels_before_project_runtimes;

CREATE TABLE pairing_channels (
  pairing_id TEXT PRIMARY KEY,
  pairing_code_hash TEXT NOT NULL UNIQUE,
  poll_token_hash TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  runtime_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  daemon_token_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paired', 'expired', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  machine_name TEXT NOT NULL DEFAULT '',
  workspace_name TEXT NOT NULL DEFAULT '',
  agents_json TEXT NOT NULL DEFAULT '[]',
  installable_agents_json TEXT NOT NULL DEFAULT '[]',
  creation_idempotency_key TEXT,
  created_by_owner_credential_id TEXT,
  runtime_slot INTEGER NOT NULL CHECK (runtime_slot > 0),
  revoked_at INTEGER,
  revoked_by_owner_credential_id TEXT
);

INSERT INTO pairing_channels (
  pairing_id,
  pairing_code_hash,
  poll_token_hash,
  channel_id,
  runtime_id,
  tenant_id,
  project_id,
  daemon_token_hash,
  status,
  created_at,
  expires_at,
  claimed_at,
  machine_name,
  workspace_name,
  agents_json,
  installable_agents_json,
  runtime_slot
)
SELECT
  pairing_id,
  pairing_code_hash,
  poll_token_hash,
  channel_id,
  runtime_id,
  tenant_id,
  project_id,
  daemon_token_hash,
  status,
  created_at,
  expires_at,
  claimed_at,
  machine_name,
  workspace_name,
  agents_json,
  installable_agents_json,
  ROW_NUMBER() OVER (
    PARTITION BY tenant_id, project_id
    ORDER BY created_at, channel_id
  )
FROM pairing_channels_before_project_runtimes;

DROP TABLE pairing_channels_before_project_runtimes;

CREATE INDEX pairing_channels_expires_at
  ON pairing_channels(expires_at);

CREATE INDEX pairing_channels_project
  ON pairing_channels(tenant_id, project_id, channel_id);

CREATE INDEX pairing_channels_project_runtime
  ON pairing_channels(tenant_id, project_id, runtime_id);

CREATE INDEX pairing_channels_project_listing
  ON pairing_channels(tenant_id, project_id, status, created_at, channel_id);

CREATE UNIQUE INDEX pairing_channels_creation_idempotency
  ON pairing_channels(tenant_id, project_id, creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX pairing_channels_active_runtime_slot
  ON pairing_channels(tenant_id, project_id, runtime_slot)
  WHERE status IN ('pending', 'paired');

CREATE TABLE project_owner_credentials (
  credential_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  source_channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);

INSERT INTO project_owner_credentials (
  credential_id,
  tenant_id,
  project_id,
  token_hash,
  source_channel_id,
  created_at,
  last_used_at,
  revoked_at
)
SELECT
  credentials.credential_id,
  channels.tenant_id,
  channels.project_id,
  credentials.token_hash,
  channels.channel_id,
  credentials.created_at,
  credentials.last_used_at,
  credentials.revoked_at
FROM channel_host_credentials AS credentials
INNER JOIN pairing_channels AS channels
  ON channels.channel_id = credentials.channel_id
WHERE credentials.authority = 'owner';

CREATE INDEX project_owner_credentials_project
  ON project_owner_credentials(tenant_id, project_id, revoked_at, created_at);

CREATE TABLE runtime_pairing_audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'runtime_pairing.requested',
      'runtime_pairing.claimed',
      'runtime_pairing.expired',
      'runtime_pairing.revoked',
      'runtime_pairing.rejected'
    )
  ),
  details_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX runtime_pairing_audit_project
  ON runtime_pairing_audit_events(
    tenant_id,
    project_id,
    recorded_at DESC,
    audit_id DESC
  );

CREATE UNIQUE INDEX runtime_pairing_audit_lifecycle
  ON runtime_pairing_audit_events(pairing_id, action)
  WHERE action <> 'runtime_pairing.rejected';
