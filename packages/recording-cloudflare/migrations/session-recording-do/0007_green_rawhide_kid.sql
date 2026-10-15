CREATE TABLE `recorded_interactions` (
	`interaction_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`resolved` integer NOT NULL,
	`request_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recorded_interactions_resolved` ON `recorded_interactions` (`resolved`);--> statement-breakpoint
CREATE TABLE `recorded_turns` (
	`command_id` text PRIMARY KEY NOT NULL,
	`turn_order` integer NOT NULL,
	`open` integer NOT NULL,
	`turn_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorded_turns_turn_order_unique` ON `recorded_turns` (`turn_order`);--> statement-breakpoint
CREATE INDEX `recorded_turns_open` ON `recorded_turns` (`open`);--> statement-breakpoint
CREATE TABLE `recorded_turn_items` (
	`command_id` text NOT NULL,
	`item_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`command_id`, `item_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorded_turn_items_sequence` ON `recorded_turn_items` (`command_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `recording_projection` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`folded_through_ordinal` integer NOT NULL,
	`turn_count` integer NOT NULL,
	`state_json` text NOT NULL,
	CONSTRAINT "recording_projection_singleton_check" CHECK("recording_projection"."singleton" = 1)
);
