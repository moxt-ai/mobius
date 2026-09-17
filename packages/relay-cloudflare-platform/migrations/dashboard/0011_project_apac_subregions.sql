CREATE TABLE platform_projects_with_apac_subregions (
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
  location_hint TEXT NOT NULL DEFAULT 'apac'
    CHECK (location_hint IN ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me')),
  UNIQUE(app_id, idempotency_key),
  UNIQUE(app_id, client_reference)
);

INSERT INTO platform_projects_with_apac_subregions (
  project_id, tenant_id, app_id, display_name, client_reference, idempotency_key,
  request_digest, lifecycle, created_at, updated_at, suspended_at, deleted_at, location_hint
)
SELECT
  project_id, tenant_id, app_id, display_name, client_reference, idempotency_key,
  request_digest, lifecycle, created_at, updated_at, suspended_at, deleted_at, location_hint
FROM platform_projects;

DROP TABLE platform_projects;
ALTER TABLE platform_projects_with_apac_subregions RENAME TO platform_projects;

CREATE INDEX platform_projects_app
  ON platform_projects(app_id, lifecycle, created_at, project_id);
CREATE INDEX platform_projects_tenant
  ON platform_projects(tenant_id, lifecycle, created_at, project_id);
