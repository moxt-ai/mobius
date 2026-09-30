CREATE TABLE `standalone_project_recording_configurations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`configured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `standalone_projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`owner_token_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `standalone_projects_owner_token_hash_unique` ON `standalone_projects` (`owner_token_hash`);--> statement-breakpoint
DROP TABLE `standalone_recording_configuration`;