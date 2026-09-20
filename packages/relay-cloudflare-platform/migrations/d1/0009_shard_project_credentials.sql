-- Clean-reset cutover. Apply Platform sharding migrations before deploying the new Worker.
DROP TABLE platform_app_credential_projects;
DROP TABLE session_access_credentials;
DROP TABLE conversation_access_credentials;
DROP TABLE platform_audit_events;

CREATE TABLE platform_dashboard_audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL CHECK (project_id = ''),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
  details_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX platform_dashboard_audit_events_tenant
  ON platform_dashboard_audit_events(tenant_id, recorded_at DESC, audit_id DESC);
