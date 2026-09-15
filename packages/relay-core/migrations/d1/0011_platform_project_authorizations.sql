CREATE TABLE platform_project_authorizations (
    project_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'suspended', 'deleted'))
);

-- App tombstones also deny a Project provisioned concurrently with deletion.
CREATE TABLE platform_project_app_revocations (
    app_id TEXT PRIMARY KEY
);
