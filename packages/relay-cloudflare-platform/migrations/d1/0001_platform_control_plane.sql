CREATE TABLE platform_tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'suspended', 'deleted')),
  quotas_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE platform_developer_memberships (
  membership_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'developer')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(provider_id, issuer, subject, tenant_id)
);

CREATE INDEX platform_developer_memberships_identity
  ON platform_developer_memberships(provider_id, issuer, subject, revoked_at);

CREATE TABLE platform_apps (
  app_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'suspended', 'deleted')),
  default_credential_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER,
  UNIQUE(tenant_id, display_name)
);

CREATE INDEX platform_apps_tenant
  ON platform_apps(tenant_id, lifecycle, created_at, app_id);

CREATE TABLE platform_projects (
  project_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  client_reference TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'suspended', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER,
  UNIQUE(app_id, idempotency_key),
  UNIQUE(app_id, client_reference)
);

CREATE INDEX platform_projects_app
  ON platform_projects(app_id, lifecycle, created_at, project_id);

CREATE INDEX platform_projects_tenant
  ON platform_projects(tenant_id, lifecycle, created_at, project_id);

CREATE TABLE platform_app_credentials (
  credential_id TEXT PRIMARY KEY,
  public_credential_id TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  all_projects INTEGER NOT NULL CHECK (all_projects IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  overlap_ends_at INTEGER,
  replaced_by_credential_id TEXT,
  revoked_at INTEGER
);

CREATE INDEX platform_app_credentials_lookup
  ON platform_app_credentials(public_credential_id, revoked_at, expires_at, overlap_ends_at);

CREATE INDEX platform_app_credentials_app
  ON platform_app_credentials(app_id, issued_at DESC, credential_id DESC);

CREATE TABLE platform_app_credential_projects (
  credential_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, project_id)
);

CREATE INDEX platform_app_credential_projects_project
  ON platform_app_credential_projects(project_id, credential_id);

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
  project_id TEXT NOT NULL,
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
