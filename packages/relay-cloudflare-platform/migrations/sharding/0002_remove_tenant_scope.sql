DROP INDEX `platform_audit_events_tenant`;--> statement-breakpoint
DROP INDEX `platform_audit_events_project`;--> statement-breakpoint
CREATE INDEX `platform_audit_events_project` ON `platform_audit_events` (`project_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
ALTER TABLE `platform_audit_events` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `conversation_access_credentials_session`;--> statement-breakpoint
CREATE INDEX `conversation_access_credentials_session` ON `conversation_access_credentials` (`project_id`,`session_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
ALTER TABLE `conversation_access_credentials` DROP COLUMN `tenant_id`;