CREATE TABLE `recording_location` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`location` text NOT NULL,
	CONSTRAINT "recording_location_singleton_check" CHECK("recording_location"."singleton" = 1),
	CONSTRAINT "recording_location_location_check" CHECK("recording_location"."location" IN ('local', 'legacy'))
);
