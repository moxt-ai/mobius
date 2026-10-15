CREATE TABLE `runtime_upgrade_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`last_seen` integer NOT NULL,
	`version` text,
	`attempt` text,
	`latest` text,
	`last_failure` text
);
