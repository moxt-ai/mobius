CREATE TABLE `platform_cloud_retention_migrations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`session_count` integer NOT NULL,
	`completed_at` integer NOT NULL
);
