import { decodeNativeSessionHistory, type NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import {
    type CreateSessionRequest,
    type ProjectScope,
    type SessionLifecycle,
    SessionRuntimeError,
    type SessionSummary,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { rowNumber, rowString } from "./sqlite-row.ts";
import type { SqliteSessionArchive } from "./sqlite-session-archive.ts";
import {
    lifecycleFromRow,
    scopeKey,
    summaryFromRow,
    validateCreateSessionRequest,
    validateDomainIdentifier,
    validateTimestamp,
} from "./sqlite-session-records.ts";
import type { SqliteSessionStore } from "./sqlite-session-store.ts";

export class SqliteSessionLifecycle {
    readonly #archive: SqliteSessionArchive;
    readonly #database: SessionSqlDatabase;
    readonly #store: SqliteSessionStore;

    constructor(database: SessionSqlDatabase, archive: SqliteSessionArchive, store: SqliteSessionStore) {
        this.#archive = archive;
        this.#database = database;
        this.#store = store;
    }
    readonly createSession = async (
        scope: ProjectScope,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        scopeKey(scope);
        validateCreateSessionRequest(request);
        const key = scopeKey(scope);
        const existing = this.#store.sessionRow(scope, request.sessionId);
        if (existing !== null) {
            const summary = summaryFromRow(existing);
            if (
                summary.runtimeId === request.runtimeId &&
                summary.agentId === request.agentId &&
                summary.createdBy === request.createdBy &&
                rowString(existing, "binding_id") === request.bindingId &&
                rowString(existing, "directory_id") === request.directoryId &&
                rowNumber(existing, "config_revision") === request.binding.configRevision &&
                summary.policy.level === request.policy.level &&
                summary.policy.retentionMilliseconds === request.policy.retentionMilliseconds &&
                summary.policy.idempotencyRetentionMilliseconds === request.policy.idempotencyRetentionMilliseconds &&
                summary.policy.hotEventLimit === request.policy.hotEventLimit &&
                summary.policy.contentLimitBytes === request.policy.contentLimitBytes
            ) {
                return summary;
            }
            throw new SessionRuntimeError("session_conflict", "The session identifier is already in use");
        }
        this.#database.transaction(() => {
            this.#store.assertSessionQuota(scope);
            this.#database.run(
                `INSERT INTO sessions (
         scope_key, tenant_id, project_id, session_id, created_by, runtime_id,
         agent_id, binding_id, directory_id, config_revision,
         binding_created_at, title, native_history_json, recording_level, retention_milliseconds,
         idempotency_retention_milliseconds, hot_event_limit,
         content_limit_bytes, lifecycle, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
                [
                    key,
                    scope.tenantId,
                    scope.projectId,
                    request.sessionId,
                    request.createdBy,
                    request.runtimeId,
                    request.agentId,
                    request.bindingId,
                    request.directoryId,
                    request.binding.configRevision,
                    now,
                    request.title,
                    request.policy.level,
                    request.policy.retentionMilliseconds,
                    request.policy.idempotencyRetentionMilliseconds,
                    request.policy.hotEventLimit,
                    request.policy.contentLimitBytes,
                    now,
                    now,
                ],
            );
            this.#database.run(
                `INSERT INTO session_bindings (
         scope_key, session_id, binding_id, runtime_id, agent_ref,
         workspace_ref, config_revision, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    key,
                    request.sessionId,
                    request.bindingId,
                    request.runtimeId,
                    request.agentId,
                    request.directoryId,
                    request.binding.configRevision,
                    now,
                ],
            );
        });
        signal.throwIfAborted();
        return summaryFromRow(this.#store.requireSessionRow(scope, request.sessionId, true));
    };

    readonly recordNativeHistory = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        title: string,
        history: NativeSessionHistory,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        if (title.length > 500) {
            throw new SessionRuntimeError("session_conflict", "The native Session title is invalid");
        }
        const session = this.#store.requireActiveSessionRow(scope, sessionId, now);
        if (rowString(session, "runtime_id") !== runtimeId) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Runtime does not own the native Session history",
            );
        }
        let encoded: string;
        try {
            encoded = JSON.stringify(decodeNativeSessionHistory(history));
        } catch (cause) {
            throw new SessionRuntimeError("session_conflict", "The native Session history is invalid", { cause });
        }
        if (new TextEncoder().encode(encoded).byteLength > rowNumber(session, "content_limit_bytes")) {
            throw new SessionRuntimeError(
                "content_too_large",
                "The native Session history exceeds the recording limit",
            );
        }
        this.#database.run(
            `UPDATE sessions
       SET native_history_json = ?, title = ?, updated_at = ?
       WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
            [encoded, title, now, scopeKey(scope), sessionId],
        );
        signal.throwIfAborted();
        return summaryFromRow(this.#store.requireSessionRow(scope, sessionId, true));
    };

    readonly deleteSession = async (
        scope: ProjectScope,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionLifecycle> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        const session = this.#store.requireSessionRow(scope, sessionId, false);
        const existingLifecycle = lifecycleFromRow(session);
        if (existingLifecycle.kind === "deleted") {
            return existingLifecycle;
        }
        if (existingLifecycle.kind === "ready") {
            this.#database.run(
                `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
                [now, now, scopeKey(scope), sessionId],
            );
        }
        await this.#archive.deleteArchivedContent(scope, sessionId, signal);
        this.#database.transaction(() => {
            for (const table of [
                "uploaded_artifacts",
                "archive_work",
                "archive_segments",
                "artifacts",
                "tool_call_views",
                "pending_work",
                "interactions",
                "session_events",
                "attempts",
                "command_receipts",
                "turns",
                "session_bindings",
            ]) {
                this.#database.run(`DELETE FROM ${table} WHERE scope_key = ? AND session_id = ?`, [
                    scopeKey(scope),
                    sessionId,
                ]);
            }
            this.#database.run(
                `UPDATE sessions
         SET lifecycle = 'deleted', delete_completed_at = ?,
             native_history_json = NULL, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
                [now, now, scopeKey(scope), sessionId],
            );
        });
        signal.throwIfAborted();
        return { completedAt: new Date(now).toISOString(), kind: "deleted" };
    };
}
