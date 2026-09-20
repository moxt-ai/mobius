CREATE TABLE `runtime_connection_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`connection_epoch` integer NOT NULL,
	`connection_id` text NOT NULL,
	`state` text NOT NULL,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer,
	CONSTRAINT "runtime_connection_state_singleton_check" CHECK("runtime_connection_state"."singleton" = 1),
	CONSTRAINT "runtime_connection_state_state_check" CHECK("runtime_connection_state"."state" in ('online', 'offline'))
);
--> statement-breakpoint
CREATE TABLE `runtime_disconnect` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`job_json` text NOT NULL,
	CONSTRAINT "runtime_disconnect_singleton_check" CHECK("runtime_disconnect"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `runtime_revocations` (
	`runtime_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revoked_at` integer NOT NULL,
	PRIMARY KEY(`runtime_id`, `project_id`)
);
