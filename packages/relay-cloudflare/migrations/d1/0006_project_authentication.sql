ALTER TABLE project_owner_credentials
  ADD COLUMN replaced_by_credential_id TEXT;

ALTER TABLE project_owner_credentials
  ADD COLUMN overlap_ends_at INTEGER;

ALTER TABLE channel_host_credentials
  ADD COLUMN replaced_by_credential_id TEXT;

ALTER TABLE channel_host_credentials
  ADD COLUMN overlap_ends_at INTEGER;

CREATE TABLE external_identity_bindings (
  binding_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  UNIQUE(provider_id, issuer, subject)
);

CREATE INDEX external_identity_bindings_lookup
  ON external_identity_bindings(provider_id, issuer, subject);

CREATE TABLE external_identity_project_grants (
  grant_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_by_actor_kind TEXT NOT NULL CHECK (
    created_by_actor_kind IN ('accountless_owner', 'application', 'browser_access', 'external_identity')
  ),
  created_by_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX external_identity_project_grants_active
  ON external_identity_project_grants(binding_id, tenant_id, project_id)
  WHERE revoked_at IS NULL;

CREATE INDEX external_identity_project_grants_project
  ON external_identity_project_grants(tenant_id, project_id, revoked_at, created_at DESC);

CREATE TABLE mobius_access_credentials (
  credential_id TEXT PRIMARY KEY,
  public_credential_id TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  permissions_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX mobius_access_credentials_active
  ON mobius_access_credentials(public_credential_id, revoked_at, expires_at);

CREATE INDEX mobius_access_credentials_project
  ON mobius_access_credentials(tenant_id, project_id, revoked_at, expires_at);

CREATE TABLE project_applications (
  application_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(tenant_id, project_id, name)
);

CREATE INDEX project_applications_project
  ON project_applications(tenant_id, project_id, lifecycle, created_at DESC);

CREATE INDEX project_applications_scope
  ON project_applications(tenant_id, project_id, application_id);

CREATE TABLE project_application_credentials (
  credential_id TEXT PRIMARY KEY,
  public_credential_id TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  overlap_ends_at INTEGER,
  replaced_by_credential_id TEXT,
  revoked_at INTEGER
);

CREATE INDEX project_application_credentials_active
  ON project_application_credentials(public_credential_id, revoked_at, expires_at, overlap_ends_at);

CREATE INDEX project_application_credentials_application
  ON project_application_credentials(application_id, issued_at DESC, credential_id DESC);

CREATE TABLE authentication_audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (
    actor_kind IN ('accountless_owner', 'application', 'browser_access', 'external_identity')
  ),
  actor_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
  details_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX authentication_audit_events_project
  ON authentication_audit_events(
    tenant_id,
    project_id,
    recorded_at DESC,
    audit_id DESC
  );

CREATE TABLE public_project_bootstrap_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX public_project_bootstrap_events_limit
  ON public_project_bootstrap_events(tenant_id, client_fingerprint, created_at DESC);

CREATE INDEX public_project_bootstrap_events_retention
  ON public_project_bootstrap_events(tenant_id, created_at);
