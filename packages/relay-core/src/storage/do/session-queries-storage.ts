import { and, desc, eq, getTableColumns, lt, or } from "drizzle-orm";
import {
    ActiveResponseBlockRecordSchema,
    type ActivityDetailRecord,
    ActivityDetailRecordSchema,
    type AttemptRecord,
    AttemptRecordSchema,
    type CanonicalMessageRecord,
    CanonicalMessageRecordSchema,
    type CommittedEventRecord,
    CommittedEventRecordSchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type MessageChunkRecord,
    MessageChunkRecordSchema,
    type RuntimeIdentity,
    RuntimeIdentitySchema,
    SessionConfigurationRecordSchema,
    type SessionRecord,
    SessionRecordSchema,
    type TurnActivityRecord,
    TurnActivityRecordSchema,
    type TurnContentRecord,
    TurnContentRecordSchema,
    type TurnMessageAnchorLookup,
    TurnMessageAnchorLookupSchema,
    type TurnRecord,
    TurnRecordSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import { sessions } from "../../schema/session-do/sessions.ts";
import { turns } from "../../schema/session-do/turns.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import { decodeStreamBlock, sessionDeltaText } from "./session-stream-codec.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";

function placeholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}

export class SessionQueriesStorage {
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }

    readonly findTurn = (scopeKey: string, sessionId: string, turnId: string): TurnRecord | undefined =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
                [scopeKey, sessionId, turnId],
            ),
        )[0];

    readonly readConfiguration = (scopeKey: string, sessionId: string) =>
        decodeStorageRows(
            SessionConfigurationRecordSchema,
            this.#database.query(
                `SELECT config_options_json, config_revision, updated_at
                   FROM session_configuration_snapshots
                  WHERE scope_key = ? AND session_id = ?`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly listTurnMessageIds = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandIds: readonly string[];
    }): readonly TurnMessageAnchorLookup[] => {
        if (input.commandIds.length === 0) {
            return [];
        }
        return decodeStorageRows(
            TurnMessageAnchorLookupSchema,
            this.#database.query(
                `SELECT command_id, message_id FROM turn_message_anchors
       WHERE scope_key = ? AND session_id = ? AND command_id IN (${placeholders(input.commandIds.length)})`,
                [input.scopeKey, input.sessionId, ...input.commandIds],
            ),
        );
    };

    /**
     * The narration increments an activity has accumulated, concatenated in the order
     * the Attempt produced them. A Turn that is still running keeps these rows instead
     * of re-storing the whole narration on its snapshot row.
     */
    readonly readActivityNarration = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
        readonly activityId: string;
    }): string => {
        const row = this.#database.query(
            `SELECT group_concat(text, '') AS narration
               FROM (
                   SELECT text FROM tool_call_narrations
                    WHERE scope_key = ? AND session_id = ? AND attempt_id = ? AND activity_id = ?
                    ORDER BY sequence
               )`,
            [input.scopeKey, input.sessionId, input.attemptId, input.activityId],
        )[0];
        if (row === undefined) {
            return "";
        }
        return rowNullableString(row, "narration") ?? "";
    };

    readonly listTurnContents = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandIds: readonly string[];
    }): readonly TurnContentRecord[] => {
        if (input.commandIds.length === 0) {
            return [];
        }
        return decodeStorageRows(
            TurnContentRecordSchema,
            this.#database.query(
                `SELECT command_id, content_id, content_json, event_sequence
                   FROM turn_content_views
                  WHERE scope_key = ? AND session_id = ? AND command_id IN (${placeholders(input.commandIds.length)})
                  ORDER BY command_id, event_sequence`,
                [input.scopeKey, input.sessionId, ...input.commandIds],
            ),
        );
    };

    readonly listCanonicalAssistantMessages = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandIds: readonly string[];
    }): readonly CanonicalMessageRecord[] => {
        if (input.commandIds.length === 0) {
            return [];
        }
        const messages = decodeStorageRows(
            CanonicalMessageRecordSchema,
            this.#database.query(
                `SELECT command_id, message_id, content, content_chunks
               FROM session_messages
              WHERE scope_key = ? AND session_id = ? AND role = 'assistant'
                AND command_id IN (${placeholders(input.commandIds.length)})`,
                [input.scopeKey, input.sessionId, ...input.commandIds],
            ),
        );
        if (messages.length === 0) {
            return [];
        }
        const chunksByMessage = new Map<string, MessageChunkRecord[]>();
        for (const chunk of decodeStorageRows(
            MessageChunkRecordSchema,
            this.#database.query(
                `SELECT message_id, chunk_index, content
               FROM session_message_chunks
              WHERE scope_key = ? AND session_id = ?
                AND message_id IN (${placeholders(messages.length)})
              ORDER BY message_id, chunk_index`,
                [input.scopeKey, input.sessionId, ...messages.map((message) => message.message_id)],
            ),
        )) {
            const forMessage = chunksByMessage.get(chunk.message_id);
            if (forMessage === undefined) {
                chunksByMessage.set(chunk.message_id, [chunk]);
            } else {
                forMessage.push(chunk);
            }
        }
        return messages.map((message) => {
            const chunks = chunksByMessage.get(message.message_id) ?? [];
            if (chunks.length !== message.content_chunks) {
                throw new DatabaseError(
                    "database_statement_invalid",
                    "The canonical Session message chunks are incomplete",
                );
            }
            let content = message.content;
            for (let index = 0; index < chunks.length; index += 1) {
                const chunk = chunks[index];
                if (chunk === undefined || chunk.chunk_index !== index + 1) {
                    throw new DatabaseError(
                        "database_statement_invalid",
                        "The canonical Session message chunks are invalid",
                    );
                }
                content += chunk.content;
            }
            return {
                command_id: message.command_id,
                content,
                content_chunks: message.content_chunks,
                message_id: message.message_id,
            };
        });
    };

    readonly listActiveTurnResponses = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandIds: readonly string[];
    }): ReadonlyMap<string, string> => {
        if (input.commandIds.length === 0) {
            return new Map();
        }
        const rows = decodeStorageRows(
            ActiveResponseBlockRecordSchema,
            this.#database.query(
                `SELECT stream.command_id AS command_id, block.payload AS payload
               FROM session_streams stream
               INNER JOIN session_stream_blocks block
                 ON block.scope_key = stream.scope_key
                AND block.session_id = stream.session_id
                AND block.stream_id = stream.stream_id
              WHERE stream.scope_key = ? AND stream.session_id = ?
                AND stream.command_id IN (${placeholders(input.commandIds.length)})
              ORDER BY stream.command_id, block.block_index`,
                [input.scopeKey, input.sessionId, ...input.commandIds],
            ),
        );
        const responses = new Map<string, string>();
        for (const row of rows) {
            const current = responses.get(row.command_id) ?? "";
            let appended = current;
            for (const event of decodeStreamBlock(row.payload)) {
                appended += sessionDeltaText(event.payload);
            }
            responses.set(row.command_id, appended);
        }
        return responses;
    };

    readonly readActiveEventPayload = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly sequenceNumber: number;
    }): string | undefined => {
        const row = this.#database.query(
            `SELECT block.payload, reference.event_index
               FROM session_stream_event_refs reference
               INNER JOIN session_stream_blocks block
                 ON block.scope_key = reference.scope_key
                AND block.session_id = reference.session_id
                AND block.stream_id = reference.stream_id
                AND block.block_index = reference.block_index
              WHERE reference.scope_key = ? AND reference.session_id = ?
                AND reference.sequence_number = ?`,
            [input.scopeKey, input.sessionId, input.sequenceNumber],
        )[0];
        if (row === undefined) {
            return undefined;
        }
        const event = decodeStreamBlock(rowString(row, "payload"))[rowNumber(row, "event_index")];
        if (event === undefined || event.sequence !== input.sequenceNumber) {
            throw new DatabaseError("database_statement_invalid", "The session stream event reference is invalid");
        }
        return event.payload;
    };

    readonly findAttempt = (scopeKey: string, sessionId: string, attemptId: string): AttemptRecord | undefined =>
        decodeStorageRows(
            AttemptRecordSchema,
            this.#database.query(
                `SELECT * FROM attempts
       WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
                [scopeKey, sessionId, attemptId],
            ),
        )[0];

    readonly findInteraction = (
        scopeKey: string,
        sessionId: string,
        interactionId: string,
    ): InteractionRecord | undefined =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT * FROM interactions
       WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
                [scopeKey, sessionId, interactionId],
            ),
        )[0];

    readonly listPendingInteractions = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly InteractionRecord[] =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT i.* FROM interactions i
       INNER JOIN attempts a
         ON a.scope_key = i.scope_key
        AND a.session_id = i.session_id
        AND a.attempt_id = i.attempt_id
       WHERE i.scope_key = ? AND i.session_id = ?
         AND i.state IN ('pending', 'responded')
         AND a.state = 'waiting_input'
       ORDER BY i.interaction_id
       LIMIT 101`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listSessions = (input: {
        readonly scopeKey: string;
        readonly limit: number;
        readonly cursor: {
            readonly updatedAt: number;
            readonly sessionId: string;
        } | null;
    }): readonly SessionRecord[] => {
        const latestTurnState = this.#database.orm
            .select({ state: turns.state })
            .from(turns)
            .where(and(eq(turns.scope_key, sessions.scope_key), eq(turns.session_id, sessions.session_id)))
            .orderBy(desc(turns.created_at), desc(turns.command_id))
            .limit(1)
            .as("latest_turn_state");
        const cursorFilter =
            input.cursor === null
                ? undefined
                : or(
                      lt(sessions.updated_at, input.cursor.updatedAt),
                      and(
                          eq(sessions.updated_at, input.cursor.updatedAt),
                          lt(sessions.session_id, input.cursor.sessionId),
                      ),
                  );
        return decodeStorageRows(
            SessionRecordSchema,
            this.#database.orm
                .select({ ...getTableColumns(sessions), latest_turn_state: latestTurnState })
                .from(sessions)
                .where(and(eq(sessions.scope_key, input.scopeKey), eq(sessions.lifecycle, "ready"), cursorFilter))
                .orderBy(desc(sessions.updated_at), desc(sessions.session_id))
                .limit(input.limit)
                .all(),
        );
    };

    readonly listEventsAfter = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly sequenceNumber: number;
        readonly limit: number;
    }): readonly CommittedEventRecord[] =>
        decodeStorageRows(
            CommittedEventRecordSchema,
            this.#database.query(
                `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ? AND sequence_number > ?
       ORDER BY sequence_number
       LIMIT ?`,
                [input.scopeKey, input.sessionId, input.sequenceNumber, input.limit],
            ),
        );

    readonly listTurns = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly limit: number;
        readonly cursor: {
            readonly createdAt: number;
            readonly commandId: string;
        } | null;
    }): readonly TurnRecord[] =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ?
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND command_id < ?))
       ORDER BY created_at DESC, command_id DESC
       LIMIT ?`,
                [
                    input.scopeKey,
                    input.sessionId,
                    input.cursor?.createdAt ?? null,
                    input.cursor?.createdAt ?? null,
                    input.cursor?.createdAt ?? null,
                    input.cursor?.commandId ?? null,
                    input.limit,
                ],
            ),
        );

    readonly findActivityDetail = (
        scopeKey: string,
        sessionId: string,
        attemptId: string,
        activityId: string,
    ): ActivityDetailRecord | undefined =>
        decodeStorageRows(
            ActivityDetailRecordSchema,
            this.#database.query(
                `SELECT detail_kind, detail_artifact_id, hot_detail,
              captured_bytes, original_bytes
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND attempt_id = ?
         AND activity_id = ?`,
                [scopeKey, sessionId, attemptId, activityId],
            ),
        )[0];

    readonly listTurnActivities = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandIds: readonly string[];
    }): readonly TurnActivityRecord[] => {
        if (input.commandIds.length === 0) {
            return [];
        }
        return decodeStorageRows(
            TurnActivityRecordSchema,
            this.#database.query(
                `SELECT command_id, attempt_id, summary_json, detail_kind
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND command_id IN (${placeholders(input.commandIds.length)})
       ORDER BY command_id, event_sequence`,
                [input.scopeKey, input.sessionId, ...input.commandIds],
            ),
        );
    };
    readonly findTurnRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM turns t
       INNER JOIN session_bindings b
         ON b.scope_key = t.scope_key AND b.session_id = t.session_id
        AND b.binding_id = t.binding_id
       WHERE t.scope_key = ? AND t.session_id = ? AND t.turn_id = ?`,
                [input.scopeKey, input.sessionId, input.turnId],
            ),
        )[0];
    readonly findCommandRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM turns t
       INNER JOIN session_bindings b
         ON b.scope_key = t.scope_key AND b.session_id = t.session_id
        AND b.binding_id = t.binding_id
       WHERE t.scope_key = ? AND t.session_id = ? AND t.command_id = ?`,
                [input.scopeKey, input.sessionId, input.commandId],
            ),
        )[0];
    readonly findInteractionRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM interactions i
       INNER JOIN attempts a
         ON a.scope_key = i.scope_key AND a.session_id = i.session_id
        AND a.attempt_id = i.attempt_id
       INNER JOIN session_bindings b
         ON b.scope_key = a.scope_key AND b.session_id = a.session_id
        AND b.binding_id = a.binding_id
       WHERE i.scope_key = ? AND i.session_id = ? AND i.interaction_id = ?`,
                [input.scopeKey, input.sessionId, input.interactionId],
            ),
        )[0];
}
