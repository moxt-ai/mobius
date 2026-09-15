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
