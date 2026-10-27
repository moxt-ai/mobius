CREATE TABLE `projected_session_events` (
	`generation_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`generation_id`, `event_id`)
);
