CREATE TABLE `platform_app_upgrades` (
	`app_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`version` text NOT NULL,
	`percentage` integer NOT NULL,
	`updated_at` integer NOT NULL
);
