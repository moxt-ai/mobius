CREATE TABLE `recorded_session_live_events_v3` (
	`event_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`seq` integer PRIMARY KEY NOT NULL
);
