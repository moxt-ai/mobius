CREATE TABLE `platform_app_credential_scopes` (
	`credential_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`credential_id`, `project_id`)
);
