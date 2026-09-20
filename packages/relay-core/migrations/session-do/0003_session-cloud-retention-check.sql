PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`scope_key` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_by` text NOT NULL,
	`cloud_retention` integer DEFAULT 1 NOT NULL,
	`runtime_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`config_revision` integer NOT NULL,
	`binding_created_at` integer NOT NULL,
	`title` text NOT NULL,
	`native_history_json` text,
	`recording_level` text NOT NULL,
	`retention_milliseconds` integer NOT NULL,
	`idempotency_retention_milliseconds` integer NOT NULL,
	`hot_event_limit` integer NOT NULL,
	`content_limit_bytes` integer NOT NULL,
	`lifecycle` text NOT NULL,
	`delete_requested_at` integer DEFAULT 0 NOT NULL,
	`delete_completed_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`minimum_sequence` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`),
	CONSTRAINT "sessions_cloud_retention_check" CHECK(cloud_retention IN (0, 1)),
	CONSTRAINT "sessions_recording_level_check" CHECK(recording_level IN ('full', 'summary')),
	CONSTRAINT "sessions_lifecycle_check" CHECK(lifecycle IN ('ready', 'deleting', 'deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("scope_key", "project_id", "session_id", "created_by", "cloud_retention", "runtime_id", "agent_id", "binding_id", "directory_id", "config_revision", "binding_created_at", "title", "native_history_json", "recording_level", "retention_milliseconds", "idempotency_retention_milliseconds", "hot_event_limit", "content_limit_bytes", "lifecycle", "delete_requested_at", "delete_completed_at", "created_at", "updated_at", "next_sequence", "minimum_sequence") SELECT "scope_key", "project_id", "session_id", "created_by", "cloud_retention", "runtime_id", "agent_id", "binding_id", "directory_id", "config_revision", "binding_created_at", "title", "native_history_json", "recording_level", "retention_milliseconds", "idempotency_retention_milliseconds", "hot_event_limit", "content_limit_bytes", "lifecycle", "delete_requested_at", "delete_completed_at", "created_at", "updated_at", "next_sequence", "minimum_sequence" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sessions_directory` ON `sessions` (`scope_key`,`updated_at`,`session_id`);