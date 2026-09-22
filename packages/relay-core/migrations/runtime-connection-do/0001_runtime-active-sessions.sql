CREATE TABLE `runtime_active_sessions` (
	`runtime_id` text NOT NULL,
	`session_id` text NOT NULL,
	`connection_epoch` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`runtime_id`, `session_id`)
);
