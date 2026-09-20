DROP INDEX `authentication_audit_events_project`;--> statement-breakpoint
CREATE INDEX `authentication_audit_events_project` ON `authentication_audit_events` (`project_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
ALTER TABLE `authentication_audit_events` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `external_identity_project_grants_active`;--> statement-breakpoint
DROP INDEX `external_identity_project_grants_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `external_identity_project_grants_active` ON `external_identity_project_grants` (`binding_id`,`project_id`) WHERE "external_identity_project_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `external_identity_project_grants_project` ON `external_identity_project_grants` (`project_id`,`revoked_at`,"created_at" desc);--> statement-breakpoint
ALTER TABLE `external_identity_project_grants` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `mobius_access_credentials_project`;--> statement-breakpoint
CREATE INDEX `mobius_access_credentials_project` ON `mobius_access_credentials` (`project_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
ALTER TABLE `mobius_access_credentials` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `public_project_bootstrap_events_limit`;--> statement-breakpoint
DROP INDEX `public_project_bootstrap_events_retention`;--> statement-breakpoint
CREATE INDEX `public_project_bootstrap_events_limit` ON `public_project_bootstrap_events` (`client_fingerprint`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `public_project_bootstrap_events_retention` ON `public_project_bootstrap_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `public_project_bootstrap_events` DROP COLUMN `tenant_id`;--> statement-breakpoint
ALTER TABLE `platform_project_authorizations` DROP COLUMN `tenant_id`;