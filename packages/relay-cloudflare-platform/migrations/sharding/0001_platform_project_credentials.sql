-- Clean-reset cutover: no directory credentials or audit history are backfilled.
CREATE TABLE platform_app_credential_projects (
  credential_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, project_id)
);
CREATE INDEX platform_app_credential_projects_project
  ON platform_app_credential_projects(project_id, credential_id);

CREATE TABLE session_access_credentials (
  credential_id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_credential_id TEXT NOT NULL,
  parent_revision INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX session_access_parent ON session_access_credentials(parent_credential_id);

CREATE TABLE conversation_access_credentials (
  credential_id TEXT PRIMARY KEY,
  public_credential_id TEXT NOT NULL UNIQUE,
  parent_credential_id TEXT NOT NULL,
  parent_credential_revision INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX conversation_access_credentials_lookup
  ON conversation_access_credentials(public_credential_id, revoked_at, expires_at);
CREATE INDEX conversation_access_credentials_session
  ON conversation_access_credentials(tenant_id, project_id, session_id, revoked_at, expires_at);

CREATE TABLE platform_audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL CHECK (project_id != ''),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
  details_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX platform_audit_events_tenant
  ON platform_audit_events(tenant_id, recorded_at DESC, audit_id DESC);
CREATE INDEX platform_audit_events_project
  ON platform_audit_events(tenant_id, project_id, recorded_at DESC, audit_id DESC);
