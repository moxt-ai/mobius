DROP INDEX bots_project;
ALTER TABLE bots DROP COLUMN tenant_id;
CREATE INDEX bots_project
    ON bots(project_id, lifecycle, updated_at DESC, bot_id DESC);

DROP INDEX bot_audit_events_bot;
ALTER TABLE bot_audit_events DROP COLUMN tenant_id;
CREATE INDEX bot_audit_events_bot
    ON bot_audit_events(project_id, bot_id, recorded_at DESC, audit_id DESC);
