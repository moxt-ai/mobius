CREATE TABLE `session_event_v2` (
	`event_json` text NOT NULL,
	`generation_id` text NOT NULL,
	`position` integer NOT NULL,
	`session_id` text NOT NULL,
	CONSTRAINT `session_event_v2_pk` PRIMARY KEY(`generation_id`, `session_id`, `position`)
);
--> statement-breakpoint
CREATE INDEX `session_event_v2_generation_session_position_index` ON `session_event_v2` (`generation_id`,`session_id`,`position`);