CREATE TABLE `platform_app_recording_policies` (
	`app_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "platform_app_recording_policies_mode_check" CHECK("platform_app_recording_policies"."mode" in ('enabled', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE `platform_project_recording_policies` (
	`project_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "platform_project_recording_policies_mode_check" CHECK("platform_project_recording_policies"."mode" in ('enabled', 'disabled'))
);
