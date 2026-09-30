CREATE TABLE `recorded_turns` (
	`attempt_id` text NOT NULL,
	`command_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`started_ordinal` integer NOT NULL,
	`state` text NOT NULL,
	`terminal_ordinal` integer,
	CONSTRAINT "recorded_turns_terminal_state_check" CHECK(("recorded_turns"."state" = 'running' AND "recorded_turns"."terminal_ordinal" IS NULL AND "recorded_turns"."settled_at" IS NULL) OR ("recorded_turns"."state" IN ('completed', 'failed') AND "recorded_turns"."terminal_ordinal" IS NOT NULL AND "recorded_turns"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `recording_fork_origin` (
	`created_at` integer NOT NULL,
	`singleton` integer PRIMARY KEY NOT NULL,
	`source_recording_epoch` text NOT NULL,
	`source_session_id` text NOT NULL,
	`through_command_id` text NOT NULL,
	CONSTRAINT "recording_fork_origin_singleton_check" CHECK("recording_fork_origin"."singleton" = 1)
);
