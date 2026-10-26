CREATE TABLE `execution_receipt` (
	`command_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`attempt_id` text NOT NULL,
	`state` text NOT NULL,
	`started` integer NOT NULL,
	`outcome` text,
	`updated_at` text NOT NULL
);
