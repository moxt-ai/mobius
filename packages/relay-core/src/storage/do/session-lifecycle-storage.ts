import { SessionCountSchema } from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { decodeStorageRecord } from "./decode-storage-rows.ts";

export class SessionLifecycleStorage {
    readonly createSession = (
        input: Parameters<SessionLifecycleStorage["insertSession"]>[0],
        limits: {
            readonly project: number;
        },
    ): "created" | "quota-exceeded" =>
        this.#database.transaction(() => {
            const project = decodeStorageRecord(
                SessionCountSchema,
                this.#database.query(
                    "SELECT COUNT(*) AS active_sessions FROM sessions WHERE project_id = ? AND lifecycle <> 'deleted'",
                    [input.projectId],
                )[0],
            ).active_sessions;
            if (project >= limits.project) {
                return "quota-exceeded";
            }
            this.insertSession(input);
            this.insertBinding({
                scopeKey: input.scopeKey,
                sessionId: input.sessionId,
                bindingId: input.bindingId,
                runtimeId: input.runtimeId,
                agentRef: input.agentId,
                workspaceRef: input.directoryId,
                configRevision: input.configRevision,
                createdAt: input.bindingCreatedAt,
            });
            return "created";
        });
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }

    readonly insertSession = (input: {
        readonly scopeKey: string;
        readonly projectId: string;
        readonly sessionId: string;
        readonly createdBy: string;
        readonly cloudRetention: boolean;
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
         scope_key, project_id, session_id, created_by, cloud_retention, runtime_id,
         agent_id, binding_id, directory_id, config_revision,
         binding_created_at, title, native_history_json, recording_level, retention_milliseconds,
         idempotency_retention_milliseconds, hot_event_limit,
         content_limit_bytes, lifecycle, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
            [
                input.scopeKey,
                input.projectId,
                input.sessionId,
                input.createdBy,
                input.cloudRetention ? 1 : 0,
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
}
