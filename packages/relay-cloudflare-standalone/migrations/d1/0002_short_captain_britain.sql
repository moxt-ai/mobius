CREATE TABLE `standalone_recording_configuration` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`configured_at` integer NOT NULL,
	CONSTRAINT "standalone_recording_configuration_singleton_check" CHECK("standalone_recording_configuration"."singleton" = 1)
);
