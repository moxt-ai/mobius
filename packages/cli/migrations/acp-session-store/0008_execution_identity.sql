CREATE TABLE `execution_identity` (
	`command_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL
);
