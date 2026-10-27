CREATE TABLE `runtime_daemon_credentials` (
	`runtime_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_daemon_credentials_token_hash_unique` ON `runtime_daemon_credentials` (`token_hash`);--> statement-breakpoint
CREATE TABLE `runtimes` (
	`runtime_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by_owner_credential_id` text,
	CONSTRAINT "runtimes_revoked_at_check" CHECK("runtimes"."revoked_at" is null or (typeof("runtimes"."revoked_at") = 'integer' and "runtimes"."revoked_at" >= 0)),
	CONSTRAINT "runtimes_revocation_actor_check" CHECK("runtimes"."revoked_by_owner_credential_id" is null or "runtimes"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtimes_channel_id_unique` ON `runtimes` (`channel_id`);--> statement-breakpoint
CREATE INDEX `runtimes_project_listing` ON `runtimes` (`project_id`,`created_at`,`channel_id`);--> statement-breakpoint
CREATE TABLE `runtime_pairing_requests` (
	`pairing_id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`creation_idempotency_key` text,
	`created_by_owner_credential_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_requests_runtime_id_unique` ON `runtime_pairing_requests` (`runtime_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_requests_pairing_code_hash_unique` ON `runtime_pairing_requests` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_requests_creation_idempotency_key_unique` ON `runtime_pairing_requests` (`creation_idempotency_key`);--> statement-breakpoint
CREATE INDEX `runtime_pairing_requests_expires_at` ON `runtime_pairing_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runtime_registrations` (
	`runtime_id` text PRIMARY KEY NOT NULL,
	`claimed_at` integer NOT NULL,
	`machine_name` text NOT NULL,
	`workspace_name` text NOT NULL,
	`agents_json` text NOT NULL
);
