import {
    type Attempt,
    decodeSessionConfigUpdatedEvent,
    type Interaction,
    type NativeMessagePage,
    type NativeSessionHistory,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import {
    type ActivityDetail,
    type ProjectScope,
    SessionConfigurationSnapshot,
    type SessionDirectoryPage,
    type SessionEventPage,
    type SessionMessagePage,
    SessionRuntimeError,
    type SessionSummary,
} from "../../entity/do/session.ts";
import type { SessionQueriesStorage } from "../../storage/do/session-queries-storage.ts";
import { rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import { paginateNativeSessionHistory } from "./native-history-pagination.ts";
import { decodeDirectoryCursor, encodeCursor } from "./session-cursors.ts";
import {
    attemptFromResourceRow,
    interactionFromRow,
    scopeKey,
    summaryFromRow,
    turnFromRow,
    validateDomainIdentifier,
    validateLimit,
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionQueryService {
    readonly #storage: SessionQueriesStorage;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly storages: { readonly queries: SessionQueriesStorage };
        readonly services: { readonly state: SessionStateService };
    }) {
        const { state: store } = cx.services;
        this.#storage = cx.storages.queries;
        this.#store = store;
    }
    readonly readSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        return summaryFromRow(this.#store.requireActiveSessionRow(scope, sessionId, Date.now()));
    };

    readonly readConfiguration = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionConfigurationSnapshot> => {
        signal.throwIfAborted();
        const session = this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const snapshot = this.#storage.readConfiguration(scopeKey(scope), sessionId);
        if (snapshot === undefined) {
            return new SessionConfigurationSnapshot(
                [],
                rowNumber(session, "config_revision"),
                new Date(rowNumber(session, "updated_at")).toISOString(),
            );
        }
        try {
            const event = decodeSessionConfigUpdatedEvent(
                JSON.stringify({
                    configOptions: JSON.parse(snapshot.config_options_json),
                    kind: "session.config.updated",
                    requestId: "stored-configuration",
                    sessionId,
                }),
            );
            return new SessionConfigurationSnapshot(
                event.configOptions,
                snapshot.config_revision,
                new Date(snapshot.updated_at).toISOString(),
            );
        } catch (cause) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The stored Session configuration is invalid",
                { cause },
            );
        }
    };

    readonly readNativeHistory = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<NativeSessionHistory | null> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        return null;
    };

    readonly queryNativeMessages = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<NativeMessagePage> => {
        const history = await this.readNativeHistory(scope, sessionId, signal);
        return paginateNativeSessionHistory(
            history ?? {
                status: "unavailable",
                cause: {
                    code: "native_history_unavailable",
                    message: "Native message history is unavailable for this Session.",
                },
            },
            scope,
            sessionId,
            cursor,
            limit,
        );
    };

    readonly readTurn = async (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<Turn> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(turnId, "turn");
        const row = this.#storage.findTurn(scopeKey(scope), sessionId, turnId);
        if (row === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
        }
        return turnFromRow(row);
    };

    readonly readTurnRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(turnId, "turn");
        const row = this.#storage.findTurnRuntime({ scopeKey: scopeKey(scope), sessionId: sessionId, turnId: turnId });
        if (row === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
        }
        return rowString(row, "runtime_id");
    };

    readonly readCommandRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(commandId, "command");
        const row = this.#storage.findCommandRuntime({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            commandId: commandId,
        });
        if (row === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
        }
        return rowString(row, "runtime_id");
    };

    readonly readAttempt = async (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        signal: AbortSignal,
    ): Promise<Attempt> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(attemptId, "attempt");
        const row = this.#storage.findAttempt(scopeKey(scope), sessionId, attemptId);
        if (row === undefined) {
            throw new SessionRuntimeError("session_not_found", "The Attempt does not exist");
        }
        return attemptFromResourceRow(row);
    };

    readonly readInteraction = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ): Promise<Interaction> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(interactionId, "interaction");
        const row = this.#storage.findInteraction(scopeKey(scope), sessionId, interactionId);
        if (row === undefined) {
            throw new SessionRuntimeError("interaction_not_found", "The Interaction does not exist");
        }
        return interactionFromRow(row);
    };

    readonly readInteractionRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        validateDomainIdentifier(interactionId, "interaction");
        const row = this.#storage.findInteractionRuntime({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            interactionId: interactionId,
        });
        if (row === undefined) {
            throw new SessionRuntimeError("interaction_not_found", "The Interaction does not exist");
        }
        return rowString(row, "runtime_id");
    };

    readonly readPendingInteractions = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<readonly Interaction[]> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const rows = this.#storage.listPendingInteractions({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
        });
        if (rows.length > 100) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The Session has too many pending Interactions",
            );
        }
        signal.throwIfAborted();
        return rows.map(interactionFromRow);
    };

    readonly listSessions = async (
        scope: ProjectScope,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionDirectoryPage> => {
        signal.throwIfAborted();
        validateLimit(limit);
        const decoded = cursor === null ? null : decodeDirectoryCursor(cursor, scope);
        const rows = this.#storage.listSessions({
            scopeKey: scopeKey(scope),
            cursor: decoded,
            limit: limit + 1,
        });
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            nextCursor:
                rows.length > limit && last !== undefined
                    ? encodeCursor({
                          projectId: scope.projectId,
                          sessionId: rowString(last, "session_id"),
                          updatedAt: rowNumber(last, "updated_at"),
                      })
                    : null,
            sessions: pageRows.map(summaryFromRow),
        };
    };

    readonly readEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        void cursor;
        void limit;
        throw new SessionRuntimeError("session_history_not_retained", "Cursor-based Session events are unavailable");
    };

    readonly readMessages = async (
        scope: ProjectScope,
        sessionId: string,
        _cursor: string | null,
        _limit: number,
        signal: AbortSignal,
    ): Promise<SessionMessagePage> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        throw new SessionRuntimeError("session_history_not_retained", "This Session does not retain cloud messages");
    };

    readonly readToolCallDetail = async (
        scope: ProjectScope,
        sessionId: string,
        _attemptId: string,
        _toolCallId: string,
        signal: AbortSignal,
    ): Promise<ActivityDetail> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        throw new SessionRuntimeError(
            "session_history_not_retained",
            "This Session does not retain cloud tool details",
        );
    };
}
