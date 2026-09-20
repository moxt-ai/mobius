CREATE TABLE `project_object_identity` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	CONSTRAINT "project_object_identity_singleton_check" CHECK("project_object_identity"."singleton" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_object_identity_project_id_unique` ON `project_object_identity` (`project_id`);