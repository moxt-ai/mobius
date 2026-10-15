CREATE TABLE `runtime_upgrade_state` (
	`project_id` text NOT NULL,
	`runtime_id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`version` text,
	`attempt` text,
	`latest` text,
	`last_failure` text
);
