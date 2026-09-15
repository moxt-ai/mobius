CREATE TABLE platform_organization_invite_links (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    creator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX platform_organization_invite_links_organization
    ON platform_organization_invite_links(organization_id, revoked_at, expires_at);
