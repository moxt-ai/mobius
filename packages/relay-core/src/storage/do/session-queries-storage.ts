import {
    type ActivityDetailRecord,
    ActivityDetailRecordSchema,
    type AttemptRecord,
    AttemptRecordSchema,
    type CommittedEventRecord,
    CommittedEventRecordSchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type RuntimeIdentity,
    RuntimeIdentitySchema,
    SessionConfigurationRecordSchema,
    type SessionRecord,
    SessionRecordSchema,
    type TurnActivityRecord,
    TurnActivityRecordSchema,
    TurnMessageAnchorRecordSchema,
    type TurnRecord,
    TurnRecordSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import { decodeStreamBlock, sessionDeltaText } from "./session-stream-codec.ts";
import { rowNumber, rowString } from "./sqlite-row.ts";

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

    readonly readTurnMessageId = (scopeKey: string, sessionId: string, commandId: string): string => {
        const anchor = decodeStorageRows(
            TurnMessageAnchorRecordSchema,
            this.#database.query(
                `SELECT message_id FROM turn_message_anchors
       WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
                [scopeKey, sessionId, commandId],
            ),
        )[0];
        return anchor === undefined ? "" : rowString(anchor, "message_id");
    };

    readonly readCanonicalAssistantMessage = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): { readonly messageId: string; readonly content: string } | undefined => {
        const message = this.#database.query(
            `SELECT message_id, content, content_chunks
               FROM session_messages
              WHERE scope_key = ? AND session_id = ? AND command_id = ? AND role = 'assistant'`,
            [input.scopeKey, input.sessionId, input.commandId],
        )[0];
        if (message === undefined) {
            return undefined;
        }
        const count = rowNumber(message, "content_chunks");
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new DatabaseError(
                "database_statement_invalid",
                "The canonical Session message chunk count is invalid",
            );
        }
        let content = rowString(message, "content");
        const chunks = this.#database.query(
            `SELECT chunk_index, content
               FROM session_message_chunks
              WHERE scope_key = ? AND session_id = ? AND message_id = ?
              ORDER BY chunk_index`,
            [input.scopeKey, input.sessionId, rowString(message, "message_id")],
        );
        if (chunks.length !== count) {
            throw new DatabaseError(
                "database_statement_invalid",
                "The canonical Session message chunks are incomplete",
            );
        }
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (chunk === undefined || rowNumber(chunk, "chunk_index") !== index + 1) {
                throw new DatabaseError(
                    "database_statement_invalid",
                    "The canonical Session message chunks are invalid",
                );
            }
            content += rowString(chunk, "content");
        }
        return { content, messageId: rowString(message, "message_id") };
    };

    readonly readActiveTurnResponse = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): string => {
        const rows = this.#database.query(
            `SELECT block.payload
               FROM session_streams stream
               INNER JOIN session_stream_blocks block
                 ON block.scope_key = stream.scope_key
                AND block.session_id = stream.session_id
                AND block.stream_id = stream.stream_id
              WHERE stream.scope_key = ? AND stream.session_id = ? AND stream.command_id = ?
              ORDER BY block.block_index`,
            [input.scopeKey, input.sessionId, input.commandId],
        );
        let response = "";
        for (const row of rows) {
            for (const event of decodeStreamBlock(rowString(row, "payload"))) {
                response += sessionDeltaText(event.payload);
            }
        }
        return response;
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
    }): readonly SessionRecord[] =>
        decodeStorageRows(
            SessionRecordSchema,
            this.#database.query(
                `SELECT * FROM sessions
       WHERE scope_key = ? AND lifecycle = 'ready'
         AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND session_id < ?))
       ORDER BY updated_at DESC, session_id DESC
       LIMIT ?`,
                [
                    input.scopeKey,
                    input.cursor?.updatedAt ?? null,
                    input.cursor?.updatedAt ?? null,
                    input.cursor?.updatedAt ?? null,
                    input.cursor?.sessionId ?? null,
                    input.limit,
                ],
            ),
        );

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
        readonly commandId: string;
    }): readonly TurnActivityRecord[] =>
        decodeStorageRows(
            TurnActivityRecordSchema,
            this.#database.query(
                `SELECT attempt_id, summary_json, detail_kind
       FROM tool_call_views
       WHERE scope_key = ? AND session_id = ? AND command_id = ?
       ORDER BY event_sequence`,
                [input.scopeKey, input.sessionId, input.commandId],
            ),
        );
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
