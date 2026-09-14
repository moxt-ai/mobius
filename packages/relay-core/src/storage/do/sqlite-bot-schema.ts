import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";

export function initializeBotSessionSchema(database: DoSqlDatabase): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS bot_session_context (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        behavior_revision_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        runtime_id TEXT NOT NULL,
        agent_ref TEXT NOT NULL,
        workspace_ref TEXT NOT NULL,
        agent_config_revision INTEGER NOT NULL CHECK (agent_config_revision > 0),
        local_grant_id TEXT NOT NULL,
        creator_kind TEXT NOT NULL CHECK (creator_kind IN ('owner', 'connection')),
        creator_principal_id TEXT NOT NULL,
        behavior_instructions TEXT NOT NULL,
        behavior_digest TEXT NOT NULL,
        allowed_delivery_targets_json TEXT NOT NULL,
        completion_policy_json TEXT NOT NULL,
        reply_route_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id),
        UNIQUE (scope_key, conversation_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bot_session_context_bot
        ON bot_session_context(scope_key, bot_id, created_at, session_id);
      CREATE TABLE IF NOT EXISTS bot_client_cursors (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cursor_token TEXT NOT NULL,
        cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('event', 'message')),
        internal_cursor TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, session_id, cursor_token),
        UNIQUE (scope_key, session_id, cursor_kind, internal_cursor)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_executions (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        behavior_revision_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (scope_key, session_id, execution_id),
        UNIQUE (scope_key, session_id, turn_id),
        UNIQUE (scope_key, session_id, command_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_execution_capabilities (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        secret_digest TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'outbound-message:create'),
        allowed_delivery_target_ids_json TEXT NOT NULL,
        usage_limit INTEGER NOT NULL CHECK (usage_limit > 0),
        usage_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (scope_key, session_id, capability_id),
        UNIQUE (scope_key, session_id, execution_id),
        UNIQUE (secret_digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_outbound_requests (
        scope_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        outbound_message_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        delivery_target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        text TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'forwarded', 'terminal_failed')),
        forwarded_at INTEGER,
        failed_at INTEGER,
        failure_code TEXT,
        PRIMARY KEY (scope_key, session_id, outbound_message_id),
        UNIQUE (scope_key, session_id, execution_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bot_outbound_pending
        ON bot_outbound_requests(scope_key, session_id, state, accepted_at, outbound_message_id);
    `);
}
