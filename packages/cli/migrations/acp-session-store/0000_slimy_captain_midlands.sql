CREATE TABLE `acp_session` (
	`session_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`cwd` text NOT NULL,
	`additional_directories` text NOT NULL,
	`prompted` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deleted_acp_session` (
	`session_id` text PRIMARY KEY NOT NULL
);
