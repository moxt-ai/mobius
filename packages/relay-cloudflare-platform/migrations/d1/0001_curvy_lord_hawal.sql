PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_projects` (
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
	CONSTRAINT "platform_projects_lifecycle_check" CHECK("__new_platform_projects"."lifecycle" in ('active', 'suspended', 'deleted')),
	CONSTRAINT "platform_projects_location_hint_check" CHECK("__new_platform_projects"."location_hint" in ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'))
);
--> statement-breakpoint
INSERT INTO `__new_platform_projects`("project_id", "tenant_id", "app_id", "display_name", "client_reference", "idempotency_key", "request_digest", "lifecycle", "created_at", "updated_at", "suspended_at", "deleted_at", "location_hint") SELECT "project_id", "tenant_id", "app_id", "display_name", "client_reference", "idempotency_key", "request_digest", "lifecycle", "created_at", "updated_at", "suspended_at", "deleted_at", "location_hint" FROM `platform_projects`;--> statement-breakpoint
DROP TABLE `platform_projects`;--> statement-breakpoint
ALTER TABLE `__new_platform_projects` RENAME TO `platform_projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `platform_projects_app` ON `platform_projects` (`app_id`,`lifecycle`,`created_at`,`project_id`);--> statement-breakpoint
CREATE INDEX `platform_projects_tenant` ON `platform_projects` (`tenant_id`,`lifecycle`,`created_at`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_idempotency_key_unique` ON `platform_projects` (`app_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_projects_app_id_client_reference_unique` ON `platform_projects` (`app_id`,`client_reference`);