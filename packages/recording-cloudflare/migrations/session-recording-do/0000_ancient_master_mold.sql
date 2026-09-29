CREATE TABLE `recorded_session_events` (
	`ordinal` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`envelope_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`source_seq` text NOT NULL,
	`stream_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorded_session_events_event_id_unique` ON `recorded_session_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `recorded_session_events_stream_order` ON `recorded_session_events` (`stream_id`,`source_seq`);--> statement-breakpoint
CREATE TABLE `recording_metadata` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`session_id` text NOT NULL,
	`recording_epoch` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "recording_metadata_singleton_check" CHECK("recording_metadata"."singleton" = 1)
);
