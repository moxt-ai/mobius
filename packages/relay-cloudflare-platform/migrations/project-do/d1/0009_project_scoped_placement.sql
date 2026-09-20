-- Project-scoped shard placement: relay-core no longer carries a tenant.
-- Drop tenant_id from the tables relay-core reads and writes. The Platform
-- control-plane and relay-cloudflare adapter tables keep their own tenant_id.

-- pairing_channels ------------------------------------------------------------
DROP INDEX pairing_channels_project;
DROP INDEX pairing_channels_project_runtime;
DROP INDEX pairing_channels_project_listing;
DROP INDEX pairing_channels_creation_idempotency;
DROP INDEX pairing_channels_active_runtime_slot;
ALTER TABLE pairing_channels DROP COLUMN tenant_id;
CREATE INDEX pairing_channels_project
    ON pairing_channels(project_id, channel_id);
CREATE INDEX pairing_channels_project_runtime
    ON pairing_channels(project_id, runtime_id);
CREATE INDEX pairing_channels_project_listing
    ON pairing_channels(project_id, status, created_at, channel_id);
CREATE UNIQUE INDEX pairing_channels_creation_idempotency
    ON pairing_channels(project_id, creation_idempotency_key)
    WHERE creation_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX pairing_channels_active_runtime_slot
    ON pairing_channels(project_id, runtime_slot)
    WHERE status IN ('pending', 'paired');

-- project_owner_credentials ---------------------------------------------------
DROP INDEX project_owner_credentials_project;
ALTER TABLE project_owner_credentials DROP COLUMN tenant_id;
CREATE INDEX project_owner_credentials_project
    ON project_owner_credentials(project_id, revoked_at, created_at);

-- runtime_pairing_audit_events ------------------------------------------------
DROP INDEX runtime_pairing_audit_project;
ALTER TABLE runtime_pairing_audit_events DROP COLUMN tenant_id;
CREATE INDEX runtime_pairing_audit_project
    ON runtime_pairing_audit_events(project_id, recorded_at DESC, audit_id DESC);

-- project_browser_credentials -------------------------------------------------
DROP INDEX project_browser_credentials_project;
ALTER TABLE project_browser_credentials DROP COLUMN tenant_id;
CREATE INDEX project_browser_credentials_project
    ON project_browser_credentials(project_id, revoked_at, expires_at, created_at);

-- session_directory -----------------------------------------------------------
-- The tenant_id column is part of the primary key, so the table must be rebuilt.
ALTER TABLE session_directory RENAME TO session_directory_legacy;
CREATE TABLE session_directory (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready', 'deleting', 'deleted')),
  updated_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
INSERT INTO session_directory (
  project_id, session_id, runtime_id, lifecycle, updated_at, summary_json
)
SELECT project_id, session_id, runtime_id, lifecycle, updated_at, summary_json
FROM session_directory_legacy;
DROP TABLE session_directory_legacy;
CREATE INDEX session_directory_page
    ON session_directory(project_id, updated_at DESC, session_id DESC);
CREATE INDEX session_directory_runtime
    ON session_directory(project_id, runtime_id, lifecycle);

-- session_quota_reservations --------------------------------------------------
-- The tenant_id column is part of the primary key, so the table must be rebuilt.
ALTER TABLE session_quota_reservations RENAME TO session_quota_reservations_legacy;
CREATE TABLE session_quota_reservations (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
INSERT INTO session_quota_reservations (project_id, session_id, reserved_at)
SELECT project_id, session_id, reserved_at
FROM session_quota_reservations_legacy;
DROP TABLE session_quota_reservations_legacy;
CREATE INDEX session_quota_project
    ON session_quota_reservations(project_id);
