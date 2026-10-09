CREATE TABLE `recorded_session_events_v2` (
	`ordinal` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`envelope_json` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE `recorded_session_events`;--> statement-breakpoint
DROP TABLE `recorded_turns`;--> statement-breakpoint
DROP TABLE `recording_fork_origin`;--> statement-breakpoint
ALTER TABLE `recording_metadata` DROP COLUMN `recording_epoch`;--> statement-breakpoint
ALTER TABLE `recording_metadata` DROP COLUMN `projection_version`;