CREATE TABLE `authentication_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`outcome` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "authentication_audit_events_actor_kind_check" CHECK("authentication_audit_events"."actor_kind" in ('application', 'browser_access', 'external_identity')),
	CONSTRAINT "authentication_audit_events_outcome_check" CHECK("authentication_audit_events"."outcome" in ('succeeded', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `authentication_audit_events_project` ON `authentication_audit_events` (`project_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
CREATE TABLE `channel_access_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_by_credential_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_credential_id` text
);
--> statement-breakpoint
CREATE INDEX `channel_access_grants_channel` ON `channel_access_grants` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `channel_host_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`authority` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`revoked_at` integer,
	`source_grant_id` text,
	`replaced_by_credential_id` text,
	`overlap_ends_at` integer,
	CONSTRAINT "channel_host_credentials_authority_check" CHECK("channel_host_credentials"."authority" in ('owner', 'linked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_host_credentials_token_hash_unique` ON `channel_host_credentials` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_host_credentials_source_grant_id_unique` ON `channel_host_credentials` (`source_grant_id`);--> statement-breakpoint
CREATE INDEX `channel_host_credentials_channel` ON `channel_host_credentials` (`channel_id`,`authority`,`revoked_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `external_identity_bindings` (
	`binding_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_verified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `external_identity_bindings_lookup` ON `external_identity_bindings` (`provider_id`,`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identity_bindings_provider_id_issuer_subject_unique` ON `external_identity_bindings` (`provider_id`,`issuer`,`subject`);--> statement-breakpoint
CREATE TABLE `external_identity_project_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`project_id` text NOT NULL,
	`permissions_json` text NOT NULL,
	`created_by_actor_kind` text NOT NULL,
	`created_by_actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "external_identity_project_grants_created_by_actor_kind_check" CHECK("external_identity_project_grants"."created_by_actor_kind" in ('application', 'browser_access', 'external_identity'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_identity_project_grants_active` ON `external_identity_project_grants` (`binding_id`,`project_id`) WHERE "external_identity_project_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `external_identity_project_grants_project` ON `external_identity_project_grants` (`project_id`,`revoked_at`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `mobius_access_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`public_credential_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`secret_digest` text NOT NULL,
	`permissions_json` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobius_access_credentials_public_credential_id_unique` ON `mobius_access_credentials` (`public_credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mobius_access_credentials_secret_digest_unique` ON `mobius_access_credentials` (`secret_digest`);--> statement-breakpoint
CREATE INDEX `mobius_access_credentials_active` ON `mobius_access_credentials` (`public_credential_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `mobius_access_credentials_project` ON `mobius_access_credentials` (`project_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `pairing_channels` (
	`pairing_id` text PRIMARY KEY NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`channel_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`project_id` text NOT NULL,
	`daemon_token_hash` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`machine_name` text DEFAULT '' NOT NULL,
	`workspace_name` text DEFAULT '' NOT NULL,
	`agents_json` text DEFAULT '[]' NOT NULL,
	`installable_agents_json` text DEFAULT '[]' NOT NULL,
	`creation_idempotency_key` text,
	`created_by_owner_credential_id` text,
	`runtime_slot` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by_owner_credential_id` text,
	CONSTRAINT "pairing_channels_status_check" CHECK("pairing_channels"."status" in ('pending', 'paired', 'expired', 'revoked')),
	CONSTRAINT "pairing_channels_runtime_slot_check" CHECK("pairing_channels"."runtime_slot" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_channels_pairing_code_hash_unique` ON `pairing_channels` (`pairing_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_channels_channel_id_unique` ON `pairing_channels` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_channels_runtime_id_unique` ON `pairing_channels` (`runtime_id`);--> statement-breakpoint
CREATE INDEX `pairing_channels_expires_at` ON `pairing_channels` (`expires_at`);--> statement-breakpoint
CREATE INDEX `pairing_channels_project` ON `pairing_channels` (`project_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `pairing_channels_project_runtime` ON `pairing_channels` (`project_id`,`runtime_id`);--> statement-breakpoint
CREATE INDEX `pairing_channels_project_listing` ON `pairing_channels` (`project_id`,`status`,`created_at`,`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_channels_creation_idempotency` ON `pairing_channels` (`project_id`,`creation_idempotency_key`) WHERE "pairing_channels"."creation_idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_channels_active_runtime_slot` ON `pairing_channels` (`project_id`,`runtime_slot`) WHERE "pairing_channels"."status" in ('pending', 'paired');--> statement-breakpoint
CREATE TABLE `platform_project_app_revocations` (
	`app_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_project_authorizations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`lifecycle` text NOT NULL,
	CONSTRAINT "platform_project_authorizations_lifecycle_check" CHECK("platform_project_authorizations"."lifecycle" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `project_browser_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_credential_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_browser_credentials_token_hash_unique` ON `project_browser_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `project_browser_credentials_project` ON `project_browser_credentials` (`project_id`,`revoked_at`,`expires_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_pairing_audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`pairing_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`details_json` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "runtime_pairing_audit_events_action_check" CHECK("runtime_pairing_audit_events"."action" in ('runtime_pairing.requested', 'runtime_pairing.claimed', 'runtime_pairing.expired', 'runtime_pairing.revoked', 'runtime_pairing.rejected'))
);
--> statement-breakpoint
CREATE INDEX `runtime_pairing_audit_project` ON `runtime_pairing_audit_events` (`project_id`,"recorded_at" desc,"audit_id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_pairing_audit_lifecycle` ON `runtime_pairing_audit_events` (`pairing_id`,`action`) WHERE "runtime_pairing_audit_events"."action" <> 'runtime_pairing.rejected';--> statement-breakpoint
CREATE TABLE `session_directory` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`lifecycle` text NOT NULL,
	`updated_at` integer NOT NULL,
	`summary_json` text NOT NULL,
	PRIMARY KEY(`project_id`, `session_id`),
	CONSTRAINT "session_directory_lifecycle_check" CHECK("session_directory"."lifecycle" in ('ready', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `session_directory_page` ON `session_directory` (`project_id`,"updated_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_directory_runtime` ON `session_directory` (`project_id`,`runtime_id`,`lifecycle`);--> statement-breakpoint
CREATE TABLE `session_quota_reservations` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`reserved_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `session_quota_project` ON `session_quota_reservations` (`project_id`);