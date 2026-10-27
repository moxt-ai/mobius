CREATE TABLE `legacy_message_identities` (
	`generation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`generation_id`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `message_id_migration` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`progress_json` text NOT NULL
);
