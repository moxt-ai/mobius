PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_app_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`public_credential_id` text NOT NULL,
	`app_id` text NOT NULL,
	`secret_digest` text NOT NULL,
	`permissions_json` text NOT NULL,
	`all_projects` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`overlap_ends_at` integer,
	`replaced_by_credential_id` text,
	`revoked_at` integer,
	CONSTRAINT "platform_app_credentials_all_projects_check" CHECK("__new_platform_app_credentials"."all_projects" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_platform_app_credentials`("credential_id", "public_credential_id", "app_id", "secret_digest", "permissions_json", "all_projects", "issued_at", "overlap_ends_at", "replaced_by_credential_id", "revoked_at") SELECT "credential_id", "public_credential_id", "app_id", "secret_digest", "permissions_json", "all_projects", "issued_at", "overlap_ends_at", "replaced_by_credential_id", "revoked_at" FROM `platform_app_credentials`;--> statement-breakpoint
DROP TABLE `platform_app_credentials`;--> statement-breakpoint
ALTER TABLE `__new_platform_app_credentials` RENAME TO `platform_app_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_app_credentials_public_credential_id_unique` ON `platform_app_credentials` (`public_credential_id`);--> statement-breakpoint
CREATE INDEX `platform_app_credentials_lookup` ON `platform_app_credentials` (`public_credential_id`,`revoked_at`,`overlap_ends_at`);--> statement-breakpoint
CREATE INDEX `platform_app_credentials_app` ON `platform_app_credentials` (`app_id`,`issued_at`,`credential_id`);