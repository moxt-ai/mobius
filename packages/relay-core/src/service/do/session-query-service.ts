import {
    AGENT_ACTIVITY_KIND,
    type Attempt,
    type CommittedSessionEvent,
    decodeNativeSessionHistory,
    decodeRecordedSessionEvent,
    decodeSessionPromptCommand,
    type Interaction,
    type NativeSessionHistory,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import {
    type ActivityDetail,
    type ProjectScope,
    type SessionDirectoryPage,
    type SessionEventPage,
    type SessionMessage,
    type SessionMessagePage,
    SessionRuntimeError,
    type SessionSummary,
} from "../../entity/do/session.ts";
import type { TurnRecord } from "../../entity/do/session-records.ts";
import type { SessionQueriesStorage } from "../../storage/do/session-queries-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import type { SessionArchiveService } from "./session-archive-service.ts";
import { decodeDirectoryCursor, decodeEventCursor, decodeMessageCursor, encodeCursor } from "./session-cursors.ts";
import {
    attemptFromResourceRow,
    attemptSummaryFromRow,
    committedFromRow,
    decodeActivityDetailPayload,
    eventCursor,
    interactionFromRow,
    lifecycleFromRow,
    scopeKey,
    summaryFromRow,
    turnFromRow,
    validateDomainIdentifier,
    validateLimit,
} from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SessionQueryService {
    readonly #archive: SessionArchiveService;
    readonly #storage: SessionQueriesStorage;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly storages: { readonly queries: SessionQueriesStorage };
        readonly services: { readonly archive: SessionArchiveService; readonly state: SessionStateService };
    }) {
        const { archive, state: store } = cx.services;
        this.#archive = archive;
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

    readonly readNativeHistory = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<NativeSessionHistory | null> => {
        signal.throwIfAborted();
        const row = this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const encoded = rowNullableString(row, "native_history_json");
        if (encoded === null) {
            return null;
        }
        try {
            return decodeNativeSessionHistory(JSON.parse(encoded));
        } catch (cause) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The stored native Session history is invalid",
                { cause },
            );
        }
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
                          tenantId: scope.tenantId,
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
        validateLimit(limit);
        const session = this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const minimum = rowNumber(session, "minimum_sequence");
        const decoded = cursor === null ? null : decodeEventCursor(cursor, scope, sessionId);
        const sequence = decoded?.sequence ?? minimum - 1;
        if (decoded !== null && sequence < minimum - 1) {
            throw new SessionRuntimeError("cursor_expired", "The event cursor has expired");
        }
        const rows = this.#storage.listEventsAfter({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            sequenceNumber: sequence,
            limit: limit + 1,
        });
        const pageRows = rows.slice(0, limit);
        const events: CommittedSessionEvent[] = [];
        for (const row of pageRows) {
            const payload = await this.#archive.readEventPayload(scope, sessionId, row, signal);
            events.push(committedFromRow(row, scope, sessionId, payload));
        }
        const last = pageRows.at(-1);
        const nextSequence = last === undefined ? sequence : rowNumber(last, "sequence_number");
        return {
            cursor: eventCursor(scope, sessionId, nextSequence),
            events,
            hasMore: rows.length > limit,
        };
    };

    readonly readMessages = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionMessagePage> => {
        signal.throwIfAborted();
        validateLimit(limit);
        const session = this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const decoded = cursor === null ? null : decodeMessageCursor(cursor, scope, sessionId);
        const rows = this.#storage.listTurns({
            scopeKey: scopeKey(scope),
            sessionId,
            cursor: decoded,
            limit: limit + 1,
        });
        const pageRows = rows.slice(0, limit);
        const messages = pageRows.map((row) => this.messageFromRow(scope, sessionId, row));
        const last = pageRows.at(-1);
        return {
            lastCommittedSeq: (rowNumber(session, "next_sequence") - 1).toString(),
            messages,
            nextCursor:
                rows.length > limit && last !== undefined
                    ? encodeCursor({
                          commandId: rowString(last, "command_id"),
                          createdAt: rowNumber(last, "created_at"),
                          projectId: scope.projectId,
                          sessionId,
                          tenantId: scope.tenantId,
                      })
                    : null,
        };
    };

    readonly readToolCallDetail = async (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ): Promise<ActivityDetail> => {
        signal.throwIfAborted();
        validateDomainIdentifier(attemptId, "attempt");
        validateDomainIdentifier(toolCallId, "tool call");
        const session = this.#store.sessionRow(scope, sessionId);
        if (session === null) {
            throw new SessionRuntimeError("session_not_found", "The session does not exist");
        }
        const lifecycle = lifecycleFromRow(session);
        if (lifecycle.kind === "deleted") {
            return { deletedAt: lifecycle.completedAt, kind: "deleted" };
        }
        if (lifecycle.kind === "deleting") {
            throw new SessionRuntimeError("session_deleted", "The session is being deleted");
        }
        const row = this.#storage.findActivityDetail(scopeKey(scope), sessionId, attemptId, toolCallId);
        if (row === undefined) {
            throw new SessionRuntimeError("artifact_not_found", "The activity detail does not exist");
        }
        const kind = rowString(row, "detail_kind");
        if (kind === "unrecorded") {
            return { kind: "unrecorded" };
        }
        if (kind === "truncated") {
            return {
                capturedBytes: rowNumber(row, "captured_bytes"),
                kind: "truncated",
                originalBytes: rowNumber(row, "original_bytes"),
            };
        }
        if (kind !== "available") {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity detail state is invalid");
        }
        const artifactId = rowNullableString(row, "detail_artifact_id");
        if (artifactId === null) {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity archive reference is missing");
        }
        const hot = rowNullableString(row, "hot_detail");
        const encoded = hot ?? (await this.#archive.readArtifact(scope, sessionId, artifactId, signal));
        const detail = decodeActivityDetailPayload(
            encoded,
            "session_storage_unavailable",
            "The activity detail is invalid",
        );
        return {
            artifactId,
            content: detail.content,
            input: detail.input,
            kind: "available",
            output: detail.output,
            storage: hot === null ? "archive" : "hot",
        };
    };

    private readonly messageFromRow = (scope: ProjectScope, sessionId: string, row: TurnRecord): SessionMessage => {
        let command: SessionPromptCommand;
        try {
            command = decodeSessionPromptCommand(rowString(row, "command_json"));
        } catch (cause) {
            throw new SessionRuntimeError("session_storage_unavailable", "The stored command is invalid", { cause });
        }
        const activityRows = this.#storage.listTurnActivities({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            commandId: command.commandId,
        });
        const activities = activityRows.map((activityRow) => {
            const event = decodeRecordedSessionEvent(rowString(activityRow, "summary_json"));
            if (event.kind !== AGENT_ACTIVITY_KIND) {
                throw new SessionRuntimeError("session_storage_unavailable", "The stored activity summary is invalid");
            }
            const detailKind = rowString(activityRow, "detail_kind");
            if (detailKind !== "available" && detailKind !== "truncated" && detailKind !== "unrecorded") {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The stored activity availability is invalid",
                );
            }
            const detailAvailability: SessionMessage["activities"][number]["detailAvailability"] = detailKind;
            return {
                activityId: event.activityId,
                attemptId: rowString(activityRow, "attempt_id"),
                activityType: event.activityType,
                detailAvailability,
                input: event.input,
                locations: event.locations,
                name: event.name,
                output: event.output,
                sequence: event.sequence,
                status: event.status,
                title: event.title,
                toolCallId: event.activityId,
                toolKind: event.toolKind,
            };
        });
        return {
            activities,
            additionalDirectoryIds: command.additionalDirectoryIds,
            agentId: command.agentId,
            attempt: attemptSummaryFromRow(row),
            commandId: command.commandId,
            createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
            images: command.images,
            prompt: command.prompt,
            resources: command.resources,
            response: rowString(row, "response"),
            sessionId,
        };
    };
}
