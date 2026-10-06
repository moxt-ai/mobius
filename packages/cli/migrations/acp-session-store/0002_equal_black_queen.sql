CREATE TABLE `session_event_v2` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_json` text NOT NULL,
	`position` integer NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_event_v2_session_position_unique` ON `session_event_v2` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `session_event_v2_session_position_index` ON `session_event_v2` (`session_id`,`position`);