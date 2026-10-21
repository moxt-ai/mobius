CREATE TABLE `session_event_cache` (
	`event_id` text NOT NULL,
	`event_json` text NOT NULL,
	`generation_id` text NOT NULL,
	`position` integer NOT NULL,
	`session_id` text NOT NULL,
	CONSTRAINT `session_event_cache_pk` PRIMARY KEY(`session_id`, `event_id`)
);
--> statement-breakpoint
DROP INDEX IF EXISTS `session_event_v2_generation_session_position_index`;--> statement-breakpoint
CREATE INDEX `session_event_cache_generation_session_position_index` ON `session_event_cache` (`generation_id`,`session_id`,`position`);--> statement-breakpoint
DROP TABLE `session_event_v2`;