PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_apps` (
	`app_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`display_name` text NOT NULL,
	`lifecycle` text NOT NULL,
	`default_credential_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "platform_apps_lifecycle_check" CHECK("__new_platform_apps"."lifecycle" in ('active', 'deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_platform_apps`("app_id", "tenant_id", "display_name", "lifecycle", "default_credential_id", "created_at", "updated_at", "deleted_at") SELECT "app_id", "tenant_id", "display_name", "lifecycle", "default_credential_id", "created_at", "updated_at", "deleted_at" FROM `platform_apps`;--> statement-breakpoint
DROP TABLE `platform_apps`;--> statement-breakpoint
ALTER TABLE `__new_platform_apps` RENAME TO `platform_apps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `platform_apps_tenant` ON `platform_apps` (`tenant_id`,`lifecycle`,`created_at`,`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_apps_tenant_id_display_name_unique` ON `platform_apps` (`tenant_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `__new_platform_projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`display_name` text NOT NULL,
	`client_reference` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`lifecycle` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`location_hint` text DEFAULT 'apac' NOT NULL,
	CONSTRAINT "platform_projects_lifecycle_check" CHECK("__new_platform_projects"."lifecycle" in ('active', 'deleted')),
	CONSTRAINT "platform_projects_location_hint_check" CHECK("__new_platform_projects"."location_hint" in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'))
);
--> statement-breakpoint
INSERT INTO `__new_platform_projects`("project_id", "app_id", "display_name", "client_reference", "idempotency_key", "request_digest", "lifecycle", "created_at", "updated_at", "deleted_at", "location_hint") SELECT "project_id", "app_id", "display_name", "client_reference", "idempotency_key", "request_digest", "lifecycle", "created_at", "updated_at", "deleted_at", "location_hint" FROM `platform_projects`;--> statement-breakpoint
DROP TABLE `platform_projects`;--> statement-breakpoint
ALTER TABLE `__new_platform_projects` RENAME TO `platform_projects`;--> statement-breakpoint
CREATE INDEX `platform_projects_app` ON `platform_projects` (`app_id`,`lifecycle`,`created_at`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_idempotency_key_unique` ON `platform_projects` (`app_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_client_reference_unique` ON `platform_projects` (`app_id`,`client_reference`);--> statement-breakpoint
CREATE TABLE `__new_platform_tenants` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`lifecycle` text NOT NULL,
	`quotas_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "platform_tenants_lifecycle_check" CHECK("__new_platform_tenants"."lifecycle" in ('active', 'deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_platform_tenants`("tenant_id", "display_name", "lifecycle", "quotas_json", "created_at", "updated_at", "deleted_at") SELECT "tenant_id", "display_name", "lifecycle", "quotas_json", "created_at", "updated_at", "deleted_at" FROM `platform_tenants`;--> statement-breakpoint
DROP TABLE `platform_tenants`;--> statement-breakpoint
ALTER TABLE `__new_platform_tenants` RENAME TO `platform_tenants`;