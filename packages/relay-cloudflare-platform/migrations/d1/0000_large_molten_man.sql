CREATE TABLE `platform_apps` (
	`app_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`display_name` text NOT NULL,
	`lifecycle` text NOT NULL,
	`default_credential_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`suspended_at` integer,
	`deleted_at` integer,
	CONSTRAINT "platform_apps_lifecycle_check" CHECK("platform_apps"."lifecycle" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `platform_apps_tenant` ON `platform_apps` (`tenant_id`,`lifecycle`,`created_at`,`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_apps_tenant_id_display_name_unique` ON `platform_apps` (`tenant_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `platform_app_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`public_credential_id` text NOT NULL,
	`app_id` text NOT NULL,
	`secret_digest` text NOT NULL,
	`permissions_json` text NOT NULL,
	`all_projects` integer NOT NULL,
	`revision` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`overlap_ends_at` integer,
	`replaced_by_credential_id` text,
	`revoked_at` integer,
	CONSTRAINT "platform_app_credentials_all_projects_check" CHECK("platform_app_credentials"."all_projects" in (0, 1)),
	CONSTRAINT "platform_app_credentials_revision_check" CHECK("platform_app_credentials"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_app_credentials_public_credential_id_unique` ON `platform_app_credentials` (`public_credential_id`);--> statement-breakpoint
CREATE INDEX `platform_app_credentials_lookup` ON `platform_app_credentials` (`public_credential_id`,`revoked_at`,`overlap_ends_at`);--> statement-breakpoint
CREATE INDEX `platform_app_credentials_app` ON `platform_app_credentials` (`app_id`,"issued_at" desc,"credential_id" desc);--> statement-breakpoint
CREATE TABLE `platform_app_credential_projects` (
	`credential_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`credential_id`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `platform_app_credential_projects_project` ON `platform_app_credential_projects` (`project_id`,`credential_id`);--> statement-breakpoint
CREATE TABLE `platform_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`outcome` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "platform_audit_events_project_id_check" CHECK("platform_audit_events"."project_id" != ''),
	CONSTRAINT "platform_audit_events_outcome_check" CHECK("platform_audit_events"."outcome" in ('succeeded', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `platform_audit_events_project` ON `platform_audit_events` (`project_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
CREATE TABLE `platform_dashboard_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`app_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`outcome` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "platform_dashboard_audit_events_project_id_check" CHECK("platform_dashboard_audit_events"."project_id" = ''),
	CONSTRAINT "platform_dashboard_audit_events_outcome_check" CHECK("platform_dashboard_audit_events"."outcome" in ('succeeded', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `platform_dashboard_audit_events_tenant` ON `platform_dashboard_audit_events` (`tenant_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
CREATE TABLE `platform_organization_invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_organization_invite_links_token_hash_unique` ON `platform_organization_invite_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `platform_organization_invite_links_organization` ON `platform_organization_invite_links` (`organization_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `platform_projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`app_id` text NOT NULL,
	`display_name` text NOT NULL,
	`client_reference` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`lifecycle` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`suspended_at` integer,
	`deleted_at` integer,
	`location_hint` text DEFAULT 'apac' NOT NULL,
	CONSTRAINT "platform_projects_lifecycle_check" CHECK("platform_projects"."lifecycle" in ('active', 'suspended', 'deleted')),
	CONSTRAINT "platform_projects_location_hint_check" CHECK("platform_projects"."location_hint" in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'))
);
--> statement-breakpoint
CREATE INDEX `platform_projects_app` ON `platform_projects` (`app_id`,`lifecycle`,`created_at`,`project_id`);--> statement-breakpoint
CREATE INDEX `platform_projects_tenant` ON `platform_projects` (`tenant_id`,`lifecycle`,`created_at`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_idempotency_key_unique` ON `platform_projects` (`app_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_client_reference_unique` ON `platform_projects` (`app_id`,`client_reference`);--> statement-breakpoint
CREATE TABLE `platform_tenants` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`lifecycle` text NOT NULL,
	`quotas_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`suspended_at` integer,
	`deleted_at` integer,
	CONSTRAINT "platform_tenants_lifecycle_check" CHECK("platform_tenants"."lifecycle" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `session_access_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`secret_digest` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`parent_credential_id` text NOT NULL,
	`parent_revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_access_parent` ON `session_access_credentials` (`parent_credential_id`);