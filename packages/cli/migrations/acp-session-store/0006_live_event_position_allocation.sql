CREATE TABLE `session_live_event_position_allocation` (
	`allocated_position` integer DEFAULT 100000 NOT NULL,
	`session_id` text PRIMARY KEY NOT NULL
);
