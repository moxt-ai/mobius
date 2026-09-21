import {
    AGENT_ACTIVITY_KIND,
    AGENT_CONTENT_KIND,
    type Attempt,
    type CommittedSessionEvent,
    decodeAgentContentEvent,
    decodeNativeSessionHistory,
    decodeRecordedSessionEvent,
    decodeSessionConfigUpdatedEvent,
    decodeSessionPromptCommand,
    type Interaction,
    type NativeMessagePage,
    type NativeSessionHistory,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import {
    type ActivityDetail,
    type ProjectScope,
    SessionConfigurationSnapshot,
    type SessionDirectoryPage,
    type SessionEventPage,
    type SessionMessage,
    type SessionMessagePage,
    SessionRuntimeError,
    type SessionSummary,
} from "../../entity/do/session.ts";
import type { TurnActivityRecord, TurnRecord } from "../../entity/do/session-records.ts";
import type { SessionQueriesStorage } from "../../storage/do/session-queries-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import { paginateNativeSessionHistory } from "./native-history-pagination.ts";
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
            const payload =
                rowNullableString(row, "payload") ??
                this.#storage.readActiveEventPayload({
                    scopeKey: scopeKey(scope),
                    sessionId,
                    sequenceNumber: rowNumber(row, "sequence_number"),
                });
            if (payload === null || payload === undefined) {
                throw new SessionRuntimeError("session_storage_unavailable", "The active event payload is unavailable");
            }
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
        const messages = this.messagesFromRows(scope, sessionId, pageRows);
        const last = pageRows.at(-1);
        const lastCommittedSequence = rowNumber(session, "next_sequence") - 1;
        return {
            lastCommittedSeq: lastCommittedSequence.toString(),
            messages,
            nextCursor:
                rows.length > limit && last !== undefined
                    ? encodeCursor({
                          commandId: rowString(last, "command_id"),
                          createdAt: rowNumber(last, "created_at"),
                          projectId: scope.projectId,
                          sessionId,
                      })
                    : null,
            tailEventCursor: eventCursor(scope, sessionId, lastCommittedSequence),
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
        const hotStored = hot !== null || this.#archive.hasHotArtifact(scope, sessionId, artifactId);
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
            storage: hotStored ? "hot" : "archive",
        };
    };

    private readonly messagesFromRows = (
        scope: ProjectScope,
        sessionId: string,
        rows: readonly TurnRecord[],
    ): readonly SessionMessage[] => {
        const commands = rows.map((row) => ({ command: decodeCommand(row), row }));
        const commandIds = commands.map(({ command }) => command.commandId);
        const key = { commandIds, scopeKey: scopeKey(scope), sessionId };

        const activitiesByCommand = groupByCommandId(this.#storage.listTurnActivities(key));
        const contentsByCommand = groupByCommandId(this.#storage.listTurnContents(key));
        const canonicalByCommand = new Map(
            this.#storage.listCanonicalAssistantMessages(key).map((message) => [message.command_id, message]),
        );
        const anchoredMessageIdByCommand = new Map(
            this.#storage.listTurnMessageIds(key).map((anchor) => [anchor.command_id, anchor.message_id]),
        );
        const activeResponseByCommand = this.#storage.listActiveTurnResponses({
            ...key,
            commandIds: commandIds.filter((commandId) => !canonicalByCommand.has(commandId)),
        });

        return commands.map(({ command, row }) => {
            const canonical = canonicalByCommand.get(command.commandId);
            const activeResponse =
                canonical === undefined ? (activeResponseByCommand.get(command.commandId) ?? "") : "";
            const contents = (contentsByCommand.get(command.commandId) ?? []).flatMap((contentRow) => {
                let event: ReturnType<typeof decodeAgentContentEvent>;
                try {
                    event = decodeAgentContentEvent(rowString(contentRow, "content_json"));
                } catch (cause) {
                    console.error("Stored Agent content could not be decoded", cause);
                    return [];
                }
                if (event.kind !== AGENT_CONTENT_KIND || event.commandId !== command.commandId) {
                    console.error("Stored Agent content holds an unexpected event");
                    return [];
                }
                return [event.content];
            });
            return {
                activities: (activitiesByCommand.get(command.commandId) ?? []).flatMap((activityRow) => {
                    const activity = activityFromRow(activityRow);
                    return activity === null ? [] : [activity];
                }),
                additionalDirectoryIds: command.additionalDirectoryIds,
                agentId: command.agentId,
                attempt: attemptSummaryFromRow(row),
                commandId: command.commandId,
                contents,
                createdAt: new Date(rowNumber(row, "created_at")).toISOString(),
                disposition: command.disposition,
                images: command.images,
                messageId: anchoredMessageIdByCommand.get(command.commandId) || canonical?.message_id || "",
                prompt: command.prompt,
                resources: command.resources,
                response: canonical?.content ?? `${rowString(row, "response")}${activeResponse}`,
                sessionId,
                targetCommandId: command.targetCommandId,
                turnId: rowString(row, "turn_id"),
            };
        });
    };
}

function decodeCommand(row: TurnRecord): SessionPromptCommand {
    try {
        return decodeSessionPromptCommand(rowString(row, "command_json"));
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored command is invalid", { cause });
    }
}

function groupByCommandId<TRow extends { readonly command_id: string }>(rows: readonly TRow[]): Map<string, TRow[]> {
    const grouped = new Map<string, TRow[]>();
    for (const row of rows) {
        const forCommand = grouped.get(row.command_id);
        if (forCommand === undefined) {
            grouped.set(row.command_id, [row]);
        } else {
            forCommand.push(row);
        }
    }
    return grouped;
}

/**
 * A stored step whose recorded summary a later protocol revision can no longer decode must cost only that
 * step. Failing the read would hide every other Turn in the Session, so an unreadable step is dropped and
 * reported instead of failing the page.
 */
function activityFromRow(activityRow: TurnActivityRecord): SessionMessage["activities"][number] | null {
    let event: ReturnType<typeof decodeRecordedSessionEvent>;
    try {
        event = decodeRecordedSessionEvent(activityRow.summary_json);
    } catch (cause) {
        console.error("A stored Agent activity could not be decoded", cause);
        return null;
    }
    if (event.kind !== AGENT_ACTIVITY_KIND) {
        console.error("A stored Agent activity summary holds an unexpected event kind");
        return null;
    }
    const detailKind = activityRow.detail_kind;
    const detailAvailability: SessionMessage["activities"][number]["detailAvailability"] = detailKind;
    return {
        activityId: event.activityId,
        attemptId: activityRow.attempt_id,
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
}
