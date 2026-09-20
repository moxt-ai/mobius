CREATE TABLE project_browser_credentials (
  credential_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX project_browser_credentials_project
  ON project_browser_credentials(
    tenant_id,
    project_id,
    revoked_at,
    expires_at,
    created_at
  );
