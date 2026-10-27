PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recording_session_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`additional_directory_ids_json` text NOT NULL,
	`title` text NOT NULL,
	`prompted` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_recording_session_summaries`("session_id", "runtime_id", "agent_id", "directory_id", "additional_directory_ids_json", "title", "prompted", "updated_at") SELECT "session_id", "runtime_id", "agent_id", "directory_id", "additional_directory_ids_json", "title", "prompted", "updated_at" FROM `recording_session_summaries`;--> statement-breakpoint
DROP TABLE `recording_session_summaries`;--> statement-breakpoint
ALTER TABLE `__new_recording_session_summaries` RENAME TO `recording_session_summaries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recording_session_summaries_updated` ON `recording_session_summaries` (`updated_at`,`session_id`);