CREATE TABLE `archive_segments` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`segment_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`event_count` integer NOT NULL,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`chunks_json` text,
	PRIMARY KEY(`scope_key`, `session_id`, `segment_id`),
	CONSTRAINT "archive_segments_state_check" CHECK(state IN ('pending', 'uploaded', 'published', 'deleting', 'deleted')),
	CONSTRAINT "archive_segments_table_check_3" CHECK(first_sequence <= last_sequence),
	CONSTRAINT "archive_segments_table_check_4" CHECK(event_count = last_sequence - first_sequence + 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_segments_range` ON `archive_segments` (`scope_key`,`session_id`,`first_sequence`,`last_sequence`);--> statement-breakpoint
CREATE TABLE `archive_work` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`target_id` text NOT NULL,
	`archive_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`media_type` text NOT NULL,
	`hot_payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `target_id`),
	CONSTRAINT "archive_work_archive_kind_check" CHECK(archive_kind IN ('activity', 'event'))
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`chunks_json` text,
	PRIMARY KEY(`scope_key`, `session_id`, `artifact_id`),
	CONSTRAINT "artifacts_state_check" CHECK(state IN ('uploading', 'available', 'deleting', 'deleted', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE `attempts` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`waiting_interaction_ids_json` text DEFAULT '[]' NOT NULL,
	`completed_at` integer,
	`stop_reason` text,
	`error_code` text,
	`error_message` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `attempt_id`),
	CONSTRAINT "attempts_state_check" CHECK(state IN ('dispatching', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'indeterminate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_scope_key_session_id_turn_id_attempt_id_unique` ON `attempts` (`scope_key`,`session_id`,`turn_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `command_receipts` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `command_kind`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `immutable_content` (
	`object_key` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`byte_length` integer NOT NULL,
	`content_encoding` text NOT NULL,
	`media_type` text NOT NULL,
	`sha256` text NOT NULL,
	CONSTRAINT "immutable_content_byte_length_check" CHECK(byte_length >= 0),
	CONSTRAINT "immutable_content_content_encoding_check" CHECK(content_encoding IN ('gzip', 'identity')),
	CONSTRAINT "immutable_content_sha256_check" CHECK(length(sha256) = 64)
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`interaction_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`request_json` text NOT NULL,
	`state` text NOT NULL,
	`response_json` text,
	`responder_id` text,
	`responded_at` integer,
	`resolved_at` integer,
	PRIMARY KEY(`scope_key`, `session_id`, `interaction_id`),
	CONSTRAINT "interactions_state_check" CHECK(state IN ('pending', 'responded', 'resolved', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `pending_work` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`work_id` text NOT NULL,
	`work_kind` text NOT NULL,
	`runtime_id` text NOT NULL,
	`interaction_id` text,
	`delivery_payload` text,
	`state` text NOT NULL,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`next_attempt_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	PRIMARY KEY(`scope_key`, `session_id`, `work_id`),
	CONSTRAINT "pending_work_work_kind_check" CHECK(work_kind IN ('archive', 'delete', 'dispatch', 'interaction_response', 'projection')),
	CONSTRAINT "pending_work_state_check" CHECK(state IN ('pending', 'running', 'completed', 'retryable', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `pending_work_delivery` ON `pending_work` (`scope_key`,`runtime_id`,`state`,`queued_at`,`work_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pending_work_scope_key_session_id_interaction_id_unique` ON `pending_work` (`scope_key`,`session_id`,`interaction_id`);--> statement-breakpoint
CREATE TABLE `session_bindings` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`agent_ref` text NOT NULL,
	`workspace_ref` text NOT NULL,
	`config_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `binding_id`)
);
--> statement-breakpoint
CREATE TABLE `session_configuration_snapshots` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`config_revision` integer NOT NULL,
	`config_options_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `session_content_chunks` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`content_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` text NOT NULL,
	`byte_length` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `content_id`, `chunk_index`),
	CONSTRAINT "session_content_chunks_chunk_index_check" CHECK(chunk_index >= 0),
	CONSTRAINT "session_content_chunks_byte_length_check" CHECK(byte_length >= 0)
);
--> statement-breakpoint
CREATE TABLE `session_event_receipts` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`event_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`source_seq` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `source_kind`, `source_id`),
	CONSTRAINT "session_event_receipts_source_kind_check" CHECK(source_kind IN ('attempt', 'runtime'))
);
--> statement-breakpoint
CREATE INDEX `session_event_receipts_event` ON `session_event_receipts` (`scope_key`,`session_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`event_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_seq` text NOT NULL,
	`payload` text,
	`archive_segment_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `sequence_number`),
	CONSTRAINT "session_events_source_kind_check" CHECK(source_kind IN ('attempt', 'runtime'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_scope_key_session_id_event_id_unique` ON `session_events` (`scope_key`,`session_id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_scope_key_session_id_source_kind_source_id_source_seq_unique` ON `session_events` (`scope_key`,`session_id`,`source_kind`,`source_id`,`source_seq`);--> statement-breakpoint
CREATE TABLE `session_message_chunks` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`byte_length` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `message_id`, `chunk_index`),
	CONSTRAINT "session_message_chunks_chunk_index_check" CHECK(chunk_index > 0),
	CONSTRAINT "session_message_chunks_byte_length_check" CHECK(byte_length >= 0)
);
--> statement-breakpoint
CREATE TABLE `session_messages` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`command_id` text NOT NULL,
	`role` text NOT NULL,
	`parent_id` text,
	`content` text NOT NULL,
	`content_chunks` integer DEFAULT 0 NOT NULL,
	`token_estimate` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`scope_key`, `session_id`, `message_id`),
	CONSTRAINT "session_messages_role_check" CHECK(role IN ('user', 'assistant')),
	CONSTRAINT "session_messages_content_chunks_check" CHECK(content_chunks >= 0),
	CONSTRAINT "session_messages_token_estimate_check" CHECK(token_estimate >= 0)
);
--> statement-breakpoint
CREATE INDEX `session_messages_page` ON `session_messages` (`scope_key`,`session_id`,`created_at`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_messages_scope_key_session_id_command_id_role_unique` ON `session_messages` (`scope_key`,`session_id`,`command_id`,`role`);--> statement-breakpoint
CREATE TABLE `session_stream_blocks` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`block_index` integer NOT NULL,
	`sequence_from` integer NOT NULL,
	`sequence_to` integer NOT NULL,
	`payload` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `stream_id`, `block_index`),
	CONSTRAINT "session_stream_blocks_block_index_check" CHECK(block_index >= 0),
	CONSTRAINT "session_stream_blocks_byte_length_check" CHECK(byte_length >= 0),
	CONSTRAINT "session_stream_blocks_table_check_4" CHECK(sequence_from <= sequence_to)
);
--> statement-breakpoint
CREATE TABLE `session_stream_event_refs` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`stream_id` text NOT NULL,
	`block_index` integer NOT NULL,
	`event_index` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `sequence_number`),
	CONSTRAINT "session_stream_event_refs_block_index_check" CHECK(block_index >= 0),
	CONSTRAINT "session_stream_event_refs_event_index_check" CHECK(event_index >= 0)
);
--> statement-breakpoint
CREATE INDEX `session_stream_event_refs_stream` ON `session_stream_event_refs` (`scope_key`,`session_id`,`stream_id`,`block_index`);--> statement-breakpoint
CREATE TABLE `session_streams` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`command_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`next_block_index` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `stream_id`),
	CONSTRAINT "session_streams_state_check" CHECK(state IN ('streaming'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_streams_scope_key_session_id_command_id_unique` ON `session_streams` (`scope_key`,`session_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
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
CREATE INDEX `sessions_directory` ON `sessions` (`scope_key`,`updated_at`,`session_id`);--> statement-breakpoint
CREATE TABLE `tool_call_views` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`summary_json` text NOT NULL,
	`detail_kind` text NOT NULL,
	`detail_artifact_id` text,
	`hot_detail` text,
	`captured_bytes` integer DEFAULT 0 NOT NULL,
	`original_bytes` integer DEFAULT 0 NOT NULL,
	`event_sequence` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `attempt_id`, `activity_id`),
	CONSTRAINT "tool_call_views_detail_kind_check" CHECK(detail_kind IN ('available', 'truncated', 'unrecorded'))
);
--> statement-breakpoint
CREATE INDEX `tool_call_views_command_event` ON `tool_call_views` (`scope_key`,`session_id`,`command_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX `tool_call_views_detail_artifact` ON `tool_call_views` (`scope_key`,`session_id`,`detail_artifact_id`) WHERE detail_artifact_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `turn_content_views` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`content_id` text NOT NULL,
	`content_json` text NOT NULL,
	`event_sequence` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `command_id`, `content_id`)
);
--> statement-breakpoint
CREATE INDEX `turn_content_views_command_event` ON `turn_content_views` (`scope_key`,`session_id`,`command_id`,`event_sequence`);--> statement-breakpoint
CREATE TABLE `turn_message_anchors` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`message_id` text NOT NULL,
	`event_sequence` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `command_id`)
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`command_json` text NOT NULL,
	`state` text NOT NULL,
	`response` text DEFAULT '' NOT NULL,
	`attempt_id` text,
	`started_at` integer,
	`completed_at` integer,
	`stop_reason` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_key`, `session_id`, `command_id`),
	CONSTRAINT "turns_state_check" CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate'))
);
--> statement-breakpoint
CREATE INDEX `turns_page` ON `turns` (`scope_key`,`session_id`,`created_at`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `turns_scope_key_session_id_turn_id_unique` ON `turns` (`scope_key`,`session_id`,`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `turns_scope_key_session_id_idempotency_key_unique` ON `turns` (`scope_key`,`session_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `uploaded_artifacts` (
	`scope_key` text NOT NULL,
	`session_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_target_id` text NOT NULL,
	`upload_token_hash` text NOT NULL,
	`upload_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`available_at` integer,
	PRIMARY KEY(`scope_key`, `session_id`, `artifact_id`),
	CONSTRAINT "uploaded_artifacts_state_check" CHECK(state IN ('uploading', 'available', 'expired')),
	CONSTRAINT "uploaded_artifacts_byte_length_check" CHECK(byte_length > 0),
	CONSTRAINT "uploaded_artifacts_sha256_check" CHECK(length(sha256) = 64)
);
