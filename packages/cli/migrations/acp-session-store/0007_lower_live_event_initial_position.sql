PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_live_event_position_allocation` (
	`allocated_position` integer DEFAULT 10000 NOT NULL,
	`session_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_session_live_event_position_allocation`("allocated_position", "session_id") SELECT "allocated_position", "session_id" FROM `session_live_event_position_allocation`;--> statement-breakpoint
DROP TABLE `session_live_event_position_allocation`;--> statement-breakpoint
ALTER TABLE `__new_session_live_event_position_allocation` RENAME TO `session_live_event_position_allocation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;