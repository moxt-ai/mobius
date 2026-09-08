import { decodeNativeSessionHistory, type NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { SessionDeletionStorage } from "../../storage/session/session-deletion-storage.ts";
import { SessionLifecycleStorage } from "../../storage/session/session-lifecycle-storage.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import { rowNumber, rowString } from "../../storage/session/sqlite-row.ts";
import {
    type CreateSessionRequest,
    type ProjectScope,
    type SessionLifecycle,
    SessionRuntimeError,
    type SessionSummary,
} from "./session.ts";
import type { SessionArchiveService } from "./session-archive-service.ts";
import {
    lifecycleFromRow,
    scopeKey,
    summaryFromRow,
    validateCreateSessionRequest,
    validateDomainIdentifier,
    validateTimestamp,
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionLifecycleService {
    readonly #archive: SessionArchiveService;
    readonly #storage: SessionLifecycleStorage;
    readonly #deletions: SessionDeletionStorage;
    readonly #database: SessionSqlDatabase;
    readonly #store: SessionStateService;

    constructor(database: SessionSqlDatabase, archive: SessionArchiveService, store: SessionStateService) {
        this.#archive = archive;
        this.#storage = new SessionLifecycleStorage(database);
        this.#database = database;
        this.#deletions = new SessionDeletionStorage(database);
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
            this.#storage.insertSession({
                scopeKey: key,
                tenantId: scope.tenantId,
                projectId: scope.projectId,
                sessionId: request.sessionId,
                createdBy: request.createdBy,
                runtimeId: request.runtimeId,
                agentId: request.agentId,
                bindingId: request.bindingId,
                directoryId: request.directoryId,
                configRevision: request.binding.configRevision,
                bindingCreatedAt: now,
                title: request.title,
                recordingLevel: request.policy.level,
                retentionMilliseconds: request.policy.retentionMilliseconds,
                idempotencyRetentionMilliseconds: request.policy.idempotencyRetentionMilliseconds,
                hotEventLimit: request.policy.hotEventLimit,
                contentLimitBytes: request.policy.contentLimitBytes,
                createdAt: now,
                updatedAt: now,
            });
            this.#storage.insertBinding({
                scopeKey: key,
                sessionId: request.sessionId,
                bindingId: request.bindingId,
                runtimeId: request.runtimeId,
                agentRef: request.agentId,
                workspaceRef: request.directoryId,
                configRevision: request.binding.configRevision,
                createdAt: now,
            });
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
        this.#storage.updateNativeHistory({
            nativeHistoryJson: encoded,
            title: title,
            updatedAt: now,
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
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
            this.#storage.markSessionDeleting({
                deleteRequestedAt: now,
                updatedAt: now,
                scopeKey: scopeKey(scope),
                sessionId: sessionId,
            });
        }
        await this.#archive.deleteArchivedContent(scope, sessionId, signal);
        this.#database.transaction(() => {
            this.#deletions.deleteUploadedArtifacts({ scopeKey: scopeKey(scope), sessionId });
            this.#deletions.deleteArchiveWork({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteArchiveSegments({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteArtifacts({ scopeKey: scopeKey(scope), sessionId });
            this.#deletions.deleteToolCallViews({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deletePendingWork({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteInteractions({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteSessionEvents({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteAttempts({ scopeKey: scopeKey(scope), sessionId });
            this.#deletions.deleteCommandReceipts({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#deletions.deleteTurns({ scopeKey: scopeKey(scope), sessionId });
            this.#deletions.deleteSessionBindings({
                scopeKey: scopeKey(scope),
                sessionId,
            });
            this.#storage.markSessionDeleted({
                deleteCompletedAt: now,
                updatedAt: now,
                scopeKey: scopeKey(scope),
                sessionId: sessionId,
            });
        });
        signal.throwIfAborted();
        return { completedAt: new Date(now).toISOString(), kind: "deleted" };
    };
}
