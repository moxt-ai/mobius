import type { SessionSqlDatabase } from "./session-sql-database.ts";

export class SessionLifecycleStorage {
    readonly #database: SessionSqlDatabase;
    constructor(cx: { readonly gateways: { readonly database: SessionSqlDatabase } }) {
        const { database } = cx.gateways;
        this.#database = database;
    }

    readonly insertSession = (input: {
        readonly scopeKey: string;
        readonly tenantId: string;
        readonly projectId: string;
        readonly sessionId: string;
        readonly createdBy: string;
        readonly runtimeId: string;
        readonly agentId: string;
        readonly bindingId: string;
        readonly directoryId: string;
        readonly configRevision: number;
        readonly bindingCreatedAt: number;
        readonly title: string;
        readonly recordingLevel: string;
        readonly retentionMilliseconds: number;
        readonly idempotencyRetentionMilliseconds: number;
        readonly hotEventLimit: number;
        readonly contentLimitBytes: number;
        readonly createdAt: number;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO sessions (
         scope_key, tenant_id, project_id, session_id, created_by, runtime_id,
         agent_id, binding_id, directory_id, config_revision,
         binding_created_at, title, native_history_json, recording_level, retention_milliseconds,
         idempotency_retention_milliseconds, hot_event_limit,
         content_limit_bytes, lifecycle, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
            [
                input.scopeKey,
                input.tenantId,
                input.projectId,
                input.sessionId,
                input.createdBy,
                input.runtimeId,
                input.agentId,
                input.bindingId,
                input.directoryId,
                input.configRevision,
                input.bindingCreatedAt,
                input.title,
                input.recordingLevel,
                input.retentionMilliseconds,
                input.idempotencyRetentionMilliseconds,
                input.hotEventLimit,
                input.contentLimitBytes,
                input.createdAt,
                input.updatedAt,
            ],
        );

    readonly insertBinding = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly bindingId: string;
        readonly runtimeId: string;
        readonly agentRef: string;
        readonly workspaceRef: string;
        readonly configRevision: number;
        readonly createdAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO session_bindings (
         scope_key, session_id, binding_id, runtime_id, agent_ref,
         workspace_ref, config_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.bindingId,
                input.runtimeId,
                input.agentRef,
                input.workspaceRef,
                input.configRevision,
                input.createdAt,
            ],
        );

    readonly updateNativeHistory = (input: {
        readonly nativeHistoryJson: string | null;
        readonly title: string;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
       SET native_history_json = ?, title = ?, updated_at = ?
       WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
            [input.nativeHistoryJson, input.title, input.updatedAt, input.scopeKey, input.sessionId],
        );

    readonly markSessionDeleting = (input: {
        readonly deleteRequestedAt: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
            [input.deleteRequestedAt, input.updatedAt, input.scopeKey, input.sessionId],
        );

    readonly markSessionDeleted = (input: {
        readonly deleteCompletedAt: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET lifecycle = 'deleted', delete_completed_at = ?,
             native_history_json = NULL, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
            [input.deleteCompletedAt, input.updatedAt, input.scopeKey, input.sessionId],
        );
}
