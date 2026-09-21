CREATE TABLE `tool_call_narrations` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `attempt_id`, `activity_id`, `sequence`),
	CONSTRAINT "tool_call_narrations_sequence_check" CHECK(sequence >= 0)
);
--> statement-breakpoint
CREATE INDEX `tool_call_narrations_command` ON `tool_call_narrations` (`scope_key`,`session_id`,`command_id`);