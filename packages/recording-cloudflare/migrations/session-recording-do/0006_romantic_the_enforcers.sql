CREATE TABLE `recording_retention` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`retention_milliseconds` integer NOT NULL,
	`configured_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL
);
