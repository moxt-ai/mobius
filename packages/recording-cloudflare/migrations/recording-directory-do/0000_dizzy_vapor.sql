CREATE TABLE `recording_session_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`additional_directory_ids_json` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recording_session_summaries_updated` ON `recording_session_summaries` (`updated_at`,`session_id`);