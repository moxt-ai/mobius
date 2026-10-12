CREATE TABLE `recording_session_indexes` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`first_delivered_at` integer NOT NULL,
	`last_delivered_at` integer NOT NULL,
	`recorded_event_count` integer NOT NULL,
	`expected_event_count` integer NOT NULL,
	`missing_event_count` integer NOT NULL,
	`retention_milliseconds` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `recording_session_indexes_updated` ON `recording_session_indexes` (`updated_at`,`session_id`);