import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";

export function initializeSessionSchema(database: DoSqlDatabase): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        scope_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        directory_id TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        binding_created_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        native_history_json TEXT,
        recording_level TEXT NOT NULL CHECK (recording_level IN ('full', 'summary')),
        retention_milliseconds INTEGER NOT NULL,
        idempotency_retention_milliseconds INTEGER NOT NULL,
        hot_event_limit INTEGER NOT NULL,
        content_limit_bytes INTEGER NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready', 'deleting', 'deleted')),
        delete_requested_at INTEGER NOT NULL DEFAULT 0,
        delete_completed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        minimum_sequence INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (scope_key, session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_directory
        ON sessions(scope_key, updated_at DESC, session_id DESC);
      CREATE TABLE IF NOT EXISTS session_bindings (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent_ref TEXT NOT NULL,
        workspace_ref TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, binding_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turns (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'indeterminate')),
        response TEXT NOT NULL DEFAULT '',
        attempt_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_id),
        UNIQUE (scope_key, session_id, turn_id),
        UNIQUE (scope_key, session_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS turns_page
        ON turns(scope_key, session_id, created_at DESC, command_id DESC);
      CREATE TABLE IF NOT EXISTS turn_message_anchors (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS command_receipts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, command_kind, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'indeterminate')),
        started_at INTEGER NOT NULL,
        waiting_interaction_ids_json TEXT NOT NULL DEFAULT '[]',
        completed_at INTEGER,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, attempt_id),
        UNIQUE (scope_key, session_id, turn_id, attempt_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS interactions (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'responded', 'resolved', 'expired', 'cancelled')),
        response_json TEXT,
        responder_id TEXT,
        responded_at INTEGER,
        resolved_at INTEGER,
        PRIMARY KEY (scope_key, session_id, interaction_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pending_work (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_id TEXT NOT NULL,
        work_kind TEXT NOT NULL CHECK (work_kind IN ('archive', 'delete', 'dispatch', 'interaction_response', 'projection')),
        runtime_id TEXT NOT NULL,
        interaction_id TEXT,
        delivery_payload TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'retryable', 'failed')),
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        next_attempt_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        PRIMARY KEY (scope_key, session_id, work_id),
        UNIQUE (scope_key, session_id, interaction_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_work_delivery
        ON pending_work(scope_key, runtime_id, state, queued_at, work_id);
      CREATE TABLE IF NOT EXISTS session_events (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('attempt', 'runtime')),
        source_id TEXT NOT NULL,
        source_seq TEXT NOT NULL,
        payload TEXT,
        archive_segment_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, sequence_number),
        UNIQUE (scope_key, session_id, event_id),
        UNIQUE (scope_key, session_id, source_kind, source_id, source_seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tool_call_views (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        detail_kind TEXT NOT NULL CHECK (detail_kind IN ('available', 'truncated', 'unrecorded')),
        detail_artifact_id TEXT,
        hot_detail TEXT,
        captured_bytes INTEGER NOT NULL DEFAULT 0,
        original_bytes INTEGER NOT NULL DEFAULT 0,
        event_sequence INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, attempt_id, activity_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'deleting', 'deleted', 'failed', 'expired')),
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunks_json TEXT,
        PRIMARY KEY (scope_key, session_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS uploaded_artifacts (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'expired')),
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        content_target_id TEXT NOT NULL,
        upload_token_hash TEXT NOT NULL,
        upload_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        available_at INTEGER,
        PRIMARY KEY (scope_key, session_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS archive_segments (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'published', 'deleting', 'deleted')),
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunks_json TEXT,
        PRIMARY KEY (scope_key, session_id, segment_id),
        CHECK (first_sequence <= last_sequence),
        CHECK (event_count = last_sequence - first_sequence + 1)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS archive_segments_range
        ON archive_segments(scope_key, session_id, first_sequence, last_sequence);
      CREATE TABLE IF NOT EXISTS archive_work (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        archive_kind TEXT NOT NULL CHECK (archive_kind IN ('activity', 'event')),
        owner_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        hot_payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope_key, session_id, target_id)
      ) STRICT;
    `);
}
