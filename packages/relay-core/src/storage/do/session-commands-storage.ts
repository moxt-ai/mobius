import type { SessionEventCommit } from "../../entity/do/session-event-projection.ts";
import {
    type BindingIdentity,
    BindingIdentitySchema,
    type CommandIdentity,
    CommandIdentitySchema,
    CommandResultReceiptRecordSchema,
    type CommittedEventRecord,
    CommittedEventRecordSchema,
    type EventReceiptRecord,
    EventReceiptRecordSchema,
    type PendingWorkRecord,
    PendingWorkRecordSchema,
    type RecordPresence,
    RecordPresenceSchema,
    type RuntimeIdentity,
    RuntimeIdentitySchema,
    type SessionBindingRecord,
    SessionBindingRecordSchema,
    type SourceSequenceRecord,
    SourceSequenceRecordSchema,
    type TurnAttemptRecord,
    TurnAttemptRecordSchema,
    type TurnRecord,
    TurnRecordSchema,
    type TurnRuntimeRecord,
    TurnRuntimeRecordSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionArchiveStorage } from "./session-archive-storage.ts";
import type { SessionEventProjectorStorage } from "./session-event-projector-storage.ts";
import {
    appendStreamBlock,
    decodeStreamBlock,
    SESSION_STREAM_BLOCK_BYTE_LIMIT,
    sessionDeltaText,
} from "./session-stream-codec.ts";
import { SESSION_TEXT_CHUNK_BYTE_LIMIT, splitUtf8Text, utf8ByteLength } from "./session-text-chunks.ts";
import { rowNumber, rowString } from "./sqlite-row.ts";

export class SessionCommandsStorage {
    readonly commitEvent = (plan: SessionEventCommit): boolean =>
        this.#database.transaction(() => {
            const current = this.#projections.findEventSequence(plan.scopeKey, plan.sessionId);
            const previous = this.findLatestSourceSequence(
                plan.scopeKey,
                plan.sessionId,
                plan.sourceKind,
                plan.sourceId,
            );
            if (
                current === undefined ||
                current.next_sequence !== plan.sequenceNumber ||
                (previous?.source_seq ?? null) !== plan.expectedPreviousSourceSequence
            ) {
                return false;
            }
            const scope = { scopeKey: plan.scopeKey, sessionId: plan.sessionId };
            this.#projections.applyProjection({
                ...scope,
                sequence: plan.sequenceNumber,
                now: plan.recordedAt,
                messageId: plan.messageId,
                projection: plan.projection,
            });
            if (plan.projection.kind === "response") {
                this.appendStreamMessageDelta({
                    ...scope,
                    commandId: plan.projection.commandId,
                    payload: plan.payload,
                    recordedAt: plan.recordedAt,
                    sequenceNumber: plan.sequenceNumber,
                });
            }
            if (plan.activityDetail !== null) {
                this.#archive.retainHotArtifact({
                    ...scope,
                    artifactId: plan.activityDetail.artifactId,
                    ownerId: plan.activityDetail.activityId,
                    mediaType: "application/json",
                    hotPayload: plan.activityDetail.payload,
                });
            }
            if (plan.projection.kind === "activity") {
                this.#archive.discardUnreferencedHotArtifacts(scope);
            }
            this.insertHotEvent({
                ...plan,
                payload: plan.projection.kind === "response" ? null : plan.payload,
            });
            if (
                plan.projection.kind === "activity" &&
                (plan.projection.event.status === "completed" || plan.projection.event.status === "failed") &&
                plan.activityDetail !== null
            ) {
                this.#archive.stageArtifact({
                    ...scope,
                    artifactId: plan.activityDetail.artifactId,
                    ownerId: plan.activityDetail.activityId,
                    mediaType: "application/json",
                });
            }
            if (plan.projection.kind === "complete" || plan.projection.kind === "fail") {
                this.materializeTerminalAssistantMessage({
                    ...scope,
                    commandId: plan.projection.commandId,
                    completedAt: plan.recordedAt,
                });
                this.#archive.stageTurnActivityDetails({ ...scope, commandId: plan.projection.commandId });
            }
            if (!this.hasActiveTurn(plan.scopeKey, plan.sessionId)) {
                this.#archive.discardEventsThrough({ ...scope, throughSequence: plan.sequenceNumber });
            }
            this.advanceEventSequence({ ...scope, nextSequence: plan.sequenceNumber + 1, updatedAt: plan.recordedAt });
            return true;
        });
    readonly writeDefaultBinding = (input: {
        readonly kind: "insert" | "replace" | "select";
        readonly binding: Parameters<SessionCommandsStorage["insertBinding"]>[0];
        readonly updatedAt: number;
    }): void => {
        this.#database.transaction(() => {
            switch (input.kind) {
                case "insert":
                    this.insertBinding(input.binding);
                    break;
                case "replace":
                    this.updateBinding(input.binding);
                    break;
                case "select":
                    break;
                default: {
                    const unreachable: never = input.kind;
                    return unreachable;
                }
            }
            const binding = input.binding;
            this.setDefaultBinding({
                ...binding,
                agentId: binding.agentRef,
                directoryId: binding.workspaceRef,
                bindingCreatedAt: binding.createdAt,
                updatedAt: input.updatedAt,
            });
        });
    };
    readonly insertCommandWithDispatch = (input: {
        readonly receipt: Parameters<SessionCommandsStorage["insertCommandReceipt"]>[0];
        readonly dispatch: Parameters<SessionCommandsStorage["insertDispatch"]>[0];
    }): PendingWorkRecord =>
        this.#database.transaction(() => {
            this.insertCommandReceipt(input.receipt);
            this.insertDispatch(input.dispatch);
            const pendingWork = this.findPendingWork(
                input.dispatch.scopeKey,
                input.dispatch.sessionId,
                input.dispatch.workId,
            );
            if (pendingWork === undefined) {
                throw new DatabaseError("database_unavailable", "The Session command was not committed atomically");
            }
            return pendingWork;
        });
    readonly insertTurnWithDispatch = (input: {
        readonly disposition: string;
        readonly targetCommandId: string;
        readonly prompt: string;
        readonly turn: Parameters<SessionCommandsStorage["insertQueuedTurn"]>[0];
        readonly receipt: Parameters<SessionCommandsStorage["insertCommandReceipt"]>[0];
        readonly dispatch: Parameters<SessionCommandsStorage["insertDispatch"]>[0];
    }):
        | { readonly kind: "existing"; readonly turn: TurnRecord; readonly pendingWork: PendingWorkRecord | null }
        | { readonly kind: "busy" }
        | { readonly kind: "inserted"; readonly turn: TurnRecord; readonly pendingWork: PendingWorkRecord } =>
        this.#database.transaction(() => {
            const { scopeKey, sessionId } = input.turn;
            const existing = this.findTurnByIdempotencyKey(
                scopeKey,
                sessionId,
                input.receipt.commandKind,
                input.receipt.idempotencyKey,
            );
            if (existing !== undefined) {
                const pendingWork = this.findPendingWork(scopeKey, sessionId, `dispatch_${existing.turn_id}`) ?? null;
                return { kind: "existing", turn: existing, pendingWork };
            }
            const active = this.findActiveTurn(scopeKey, sessionId);
            const acceptsSteering =
                input.disposition === "steer" && active !== undefined && active.command_id === input.targetCommandId;
            const acceptsQueue =
                input.disposition === "queue" && this.acceptsQueueTarget(scopeKey, sessionId, input.targetCommandId);
            if (
                (input.disposition === "reject" && active !== undefined) ||
                (input.disposition === "steer" && !acceptsSteering) ||
                (input.disposition === "queue" && !acceptsQueue)
            ) {
                return { kind: "busy" };
            }
            this.insertQueuedTurn(input.turn);
            this.writeCanonicalMessage({
                ...input.turn,
                commandId: input.turn.commandId,
                completedAt: input.turn.createdAt,
                content: input.prompt,
                messageId: `user-${input.turn.commandId}`,
                parentId: null,
                role: "user",
            });
            this.insertCommandReceipt(input.receipt);
            this.insertDispatch(input.dispatch);
            this.touchSession(input.turn);
            const turn = this.findTurn(scopeKey, sessionId, input.turn.turnId);
            const pendingWork = this.findPendingWork(scopeKey, sessionId, input.dispatch.workId);
            if (turn === undefined || pendingWork === undefined) {
                throw new DatabaseError("database_unavailable", "The Turn dispatch was not committed atomically");
            }
            return { kind: "inserted", turn, pendingWork };
        });
    readonly promoteQueuedTurnToSteering = (input: {
        readonly commandJson: string;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
        readonly updatedAt: number;
    }): TurnRecord =>
        this.#database.transaction(() => {
            const turnUpdate = this.#database.run(
                `UPDATE turns
         SET command_json = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?
           AND state = 'queued'
           AND COALESCE(json_extract(command_json, '$.disposition'), 'reject') = 'queue'`,
                [input.commandJson, input.updatedAt, input.scopeKey, input.sessionId, input.turnId],
            );
            if (turnUpdate.changes !== 1) {
                throw new DatabaseError("database_unavailable", "The queued Turn could not be promoted atomically");
            }
            const dispatchUpdate = this.#database.run(
                `UPDATE pending_work
         SET delivery_payload = ?
         WHERE scope_key = ? AND session_id = ? AND work_id = ?
           AND work_kind = 'dispatch' AND state = 'pending'`,
                [input.commandJson, input.scopeKey, input.sessionId, `dispatch_${input.turnId}`],
            );
            if (dispatchUpdate.changes !== 1) {
                throw new DatabaseError("database_unavailable", "The promoted Turn dispatch is unavailable");
            }
            this.touchSession(input);
            const turn = this.findTurn(input.scopeKey, input.sessionId, input.turnId);
            if (turn === undefined) {
                throw new DatabaseError("database_unavailable", "The promoted Turn disappeared");
            }
            return turn;
        });
    readonly recordRuntimeDisconnection = (input: {
        readonly scopeKey: string;
        readonly runtimeId: string;
        readonly updatedAt: number;
    }): void => {
        this.#database.transaction(() => {
            this.markRuntimeAttemptsIndeterminate({ ...input, scopeKey2: input.scopeKey });
            this.markIndeterminateTurns({ ...input, scopeKey2: input.scopeKey });
        });
    };
    readonly #database: DoSqlDatabase;
    readonly #projections: SessionEventProjectorStorage;
    readonly #archive: SessionArchiveStorage;
    constructor(cx: {
        readonly doDatabase: DoSqlDatabase;
        readonly storages: {
            readonly archive: SessionArchiveStorage;
            readonly eventProjector: SessionEventProjectorStorage;
        };
    }) {
        const { doDatabase: database } = cx;
        this.#database = database;
        this.#archive = cx.storages.archive;
        this.#projections = cx.storages.eventProjector;
    }

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
        const eventIndex = rowNumber(row, "event_index");
        const event = decodeStreamBlock(rowString(row, "payload"))[eventIndex];
        if (event === undefined || event.sequence !== input.sequenceNumber) {
            throw new DatabaseError("database_statement_invalid", "The session stream event reference is invalid");
        }
        return event.payload;
    };

    private readonly materializeTerminalAssistantMessage = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly completedAt: number;
    }): void => {
        const turn = this.#projections.findTurnByCommand(input.scopeKey, input.sessionId, input.commandId);
        if (turn === undefined) {
            throw new DatabaseError("database_unavailable", "The terminal Turn is unavailable");
        }
        const response = `${rowString(turn, "response")}${this.readStreamResponse(input)}`;
        this.writeCanonicalMessage({
            ...input,
            content: response,
            createdAt: rowNumber(turn, "created_at"),
            messageId: `assistant-${input.commandId}`,
            parentId: `user-${input.commandId}`,
            role: "assistant",
        });
        this.#database.run(
            `UPDATE turns
                SET response = ?, updated_at = ?
              WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [response, input.completedAt, input.scopeKey, input.sessionId, input.commandId],
        );
    };

    private readonly readStreamResponse = (input: {
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

    private readonly appendStreamMessageDelta = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly payload: string;
        readonly recordedAt: number;
        readonly sequenceNumber: number;
    }): void => {
        const streamId = `stream-${input.commandId}`;
        const stream = this.#database.query(
            `SELECT state, next_block_index
               FROM session_streams
              WHERE scope_key = ? AND session_id = ? AND stream_id = ?`,
            [input.scopeKey, input.sessionId, streamId],
        )[0];
        let nextBlockIndex: number;
        if (stream === undefined) {
            nextBlockIndex = 0;
            this.#database.run(
                `INSERT INTO session_streams (
                   scope_key, session_id, stream_id, command_id, message_id, state,
                   first_sequence, last_sequence, next_block_index, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?)`,
                [
                    input.scopeKey,
                    input.sessionId,
                    streamId,
                    input.commandId,
                    `assistant-${input.commandId}`,
                    input.sequenceNumber,
                    input.sequenceNumber,
                    nextBlockIndex,
                    input.recordedAt,
                    input.recordedAt,
                ],
            );
        } else {
            if (rowString(stream, "state") !== "streaming") {
                throw new DatabaseError("database_statement_invalid", "The session stream is not active");
            }
            nextBlockIndex = rowNumber(stream, "next_block_index");
        }

        const last = this.#database.query(
            `SELECT block_index, payload
               FROM session_stream_blocks
              WHERE scope_key = ? AND session_id = ? AND stream_id = ?
              ORDER BY block_index DESC
              LIMIT 1`,
            [input.scopeKey, input.sessionId, streamId],
        )[0];
        let blockIndex: number;
        let eventIndex: number;
        if (last !== undefined) {
            const entries = decodeStreamBlock(rowString(last, "payload"));
            const appended = appendStreamBlock(entries, { payload: input.payload, sequence: input.sequenceNumber });
            if (utf8ByteLength(appended.payload) <= SESSION_STREAM_BLOCK_BYTE_LIMIT) {
                blockIndex = rowNumber(last, "block_index");
                eventIndex = appended.entryIndex;
                this.#database.run(
                    `UPDATE session_stream_blocks
                        SET sequence_to = ?, payload = ?, byte_length = ?, updated_at = ?
                      WHERE scope_key = ? AND session_id = ? AND stream_id = ? AND block_index = ?`,
                    [
                        input.sequenceNumber,
                        appended.payload,
                        utf8ByteLength(appended.payload),
                        input.recordedAt,
                        input.scopeKey,
                        input.sessionId,
                        streamId,
                        blockIndex,
                    ],
                );
            } else {
                ({ blockIndex, eventIndex } = this.insertStreamBlock({
                    ...input,
                    streamId,
                    blockIndex: nextBlockIndex,
                }));
                nextBlockIndex += 1;
            }
        } else {
            ({ blockIndex, eventIndex } = this.insertStreamBlock({
                ...input,
                streamId,
                blockIndex: nextBlockIndex,
            }));
            nextBlockIndex += 1;
        }
        this.#database.run(
            `INSERT INTO session_stream_event_refs (
               scope_key, session_id, sequence_number, stream_id, block_index, event_index
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [input.scopeKey, input.sessionId, input.sequenceNumber, streamId, blockIndex, eventIndex],
        );
        this.#database.run(
            `UPDATE session_streams
                SET last_sequence = ?, next_block_index = ?, updated_at = ?
              WHERE scope_key = ? AND session_id = ? AND stream_id = ?`,
            [input.sequenceNumber, nextBlockIndex, input.recordedAt, input.scopeKey, input.sessionId, streamId],
        );
    };

    private readonly insertStreamBlock = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly streamId: string;
        readonly blockIndex: number;
        readonly payload: string;
        readonly recordedAt: number;
        readonly sequenceNumber: number;
    }): { readonly blockIndex: number; readonly eventIndex: number } => {
        const appended = appendStreamBlock([], { payload: input.payload, sequence: input.sequenceNumber });
        const byteLength = utf8ByteLength(appended.payload);
        if (byteLength > SESSION_TEXT_CHUNK_BYTE_LIMIT) {
            throw new DatabaseError(
                "database_statement_invalid",
                "The session stream event exceeds the Durable Object row limit",
            );
        }
        this.#database.run(
            `INSERT INTO session_stream_blocks (
               scope_key, session_id, stream_id, block_index, sequence_from, sequence_to,
               payload, byte_length, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.streamId,
                input.blockIndex,
                input.sequenceNumber,
                input.sequenceNumber,
                appended.payload,
                byteLength,
                input.recordedAt,
                input.recordedAt,
            ],
        );
        return { blockIndex: input.blockIndex, eventIndex: appended.entryIndex };
    };

    private readonly writeCanonicalMessage = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly messageId: string;
        readonly role: string;
        readonly parentId: string | null;
        readonly content: string;
        readonly createdAt: number;
        readonly completedAt: number | null;
    }): void => {
        const chunks = splitUtf8Text(input.content);
        const initial = chunks[0];
        if (initial === undefined) {
            throw new DatabaseError("database_statement_invalid", "The canonical Session message is empty");
        }
        this.#database.run(
            `DELETE FROM session_message_chunks
              WHERE scope_key = ? AND session_id = ?
                AND message_id IN (
                    SELECT message_id FROM session_messages
                     WHERE scope_key = ? AND session_id = ? AND command_id = ? AND role = ?
                    UNION ALL SELECT ?
                )`,
            [
                input.scopeKey,
                input.sessionId,
                input.scopeKey,
                input.sessionId,
                input.commandId,
                input.role,
                input.messageId,
            ],
        );
        this.#database.run(
            `INSERT INTO session_messages (
               scope_key, session_id, message_id, command_id, role, parent_id,
               content, content_chunks, token_estimate, created_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_key, session_id, command_id, role) DO UPDATE SET
               message_id = excluded.message_id,
               parent_id = excluded.parent_id,
               content = excluded.content,
               content_chunks = excluded.content_chunks,
               token_estimate = excluded.token_estimate,
               created_at = excluded.created_at,
               completed_at = excluded.completed_at`,
            [
                input.scopeKey,
                input.sessionId,
                input.messageId,
                input.commandId,
                input.role,
                input.parentId,
                initial,
                chunks.length - 1,
                Math.ceil(utf8ByteLength(input.content) / 4),
                input.createdAt,
                input.completedAt,
            ],
        );
        for (let index = 1; index < chunks.length; index += 1) {
            const content = chunks[index];
            if (content === undefined) {
                throw new DatabaseError("database_statement_invalid", "The canonical Session message chunk is missing");
            }
            this.#database.run(
                `INSERT INTO session_message_chunks (
                   scope_key, session_id, message_id, chunk_index, content, byte_length
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [input.scopeKey, input.sessionId, input.messageId, index, content, utf8ByteLength(content)],
            );
        }
    };

    private readonly hasActiveTurn = (scopeKey: string, sessionId: string): boolean =>
        decodeStorageRows(
            RecordPresenceSchema,
            this.#database.query(
                `SELECT 1 FROM turns
                  WHERE scope_key = ? AND session_id = ?
                    AND state IN ('running', 'indeterminate')
                  LIMIT 1`,
                [scopeKey, sessionId],
            ),
        )[0] !== undefined;

    readonly findMatchingBinding = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly bindingId: string;
        readonly runtimeId: string;
        readonly agentRef: string;
        readonly workspaceRef: string;
    }): BindingIdentity | undefined =>
        decodeStorageRows(
            BindingIdentitySchema,
            this.#database.query(
                `SELECT binding_id FROM session_bindings
       WHERE scope_key = ? AND session_id = ? AND binding_id = ?
         AND runtime_id = ? AND agent_ref = ? AND workspace_ref = ?`,
                [input.scopeKey, input.sessionId, input.bindingId, input.runtimeId, input.agentRef, input.workspaceRef],
            ),
        )[0];

    readonly findTurnByIdempotencyKey = (
        scopeKey: string,
        sessionId: string,
        commandKind: string,
        idempotencyKey: string,
    ): TurnRecord | undefined =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT t.* FROM command_receipts r
         JOIN turns t
           ON t.scope_key = r.scope_key AND t.session_id = r.session_id
          AND t.turn_id = r.result_id
         WHERE r.scope_key = ? AND r.session_id = ?
           AND r.command_kind = ? AND r.idempotency_key = ?`,
                [scopeKey, sessionId, commandKind, idempotencyKey],
            ),
        )[0];

    readonly findPendingWork = (scopeKey: string, sessionId: string, workId: string): PendingWorkRecord | undefined =>
        decodeStorageRows(
            PendingWorkRecordSchema,
            this.#database.query(
                `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                [scopeKey, sessionId, workId],
            ),
        )[0];

    readonly findActiveTurn = (scopeKey: string, sessionId: string): CommandIdentity | undefined =>
        decodeStorageRows(
            CommandIdentitySchema,
            this.#database.query(
                `SELECT command_id FROM turns
         WHERE scope_key = ? AND session_id = ?
           AND state IN ('queued', 'running', 'indeterminate')
           AND COALESCE(json_extract(command_json, '$.disposition'), 'reject') <> 'steer'
         ORDER BY rowid
         LIMIT 1`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly acceptsQueueTarget = (scopeKey: string, sessionId: string, targetCommandId: string): boolean =>
        decodeStorageRows(
            RecordPresenceSchema,
            this.#database.query(
                `SELECT 1 FROM turns target
         WHERE target.scope_key = ? AND target.session_id = ? AND target.command_id = ?
           AND COALESCE(json_extract(target.command_json, '$.disposition'), 'reject') <> 'steer'
           AND NOT EXISTS (
             SELECT 1 FROM turns later
             WHERE later.scope_key = target.scope_key AND later.session_id = target.session_id
               AND later.rowid > target.rowid
               AND COALESCE(json_extract(later.command_json, '$.disposition'), 'reject') <> 'steer'
               AND NOT (
                 COALESCE(json_extract(later.command_json, '$.disposition'), 'reject') = 'queue'
                 AND json_extract(later.command_json, '$.targetCommandId') = target.command_id
               )
           )
         LIMIT 1`,
                [scopeKey, sessionId, targetCommandId],
            ),
        ).length === 1;

    readonly insertQueuedTurn = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
        readonly turnId: string;
        readonly bindingId: string;
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly commandJson: string;
        readonly createdAt: number;
        readonly updatedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO turns (
           scope_key, session_id, command_id, turn_id, binding_id,
           idempotency_key, request_hash, command_json, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.commandId,
                input.turnId,
                input.bindingId,
                input.idempotencyKey,
                input.requestHash,
                input.commandJson,
                input.createdAt,
                input.updatedAt,
            ],
        );

    readonly insertCommandReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandKind: string;
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly resultId: string;
        readonly acceptedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO command_receipts (
           scope_key, session_id, command_kind, idempotency_key,
           request_hash, result_id, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.commandKind,
                input.idempotencyKey,
                input.requestHash,
                input.resultId,
                input.acceptedAt,
            ],
        );

    readonly insertDispatch = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly workId: string;
        readonly runtimeId: string;
        readonly deliveryPayload: string | null;
        readonly queuedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
            [input.scopeKey, input.sessionId, input.workId, input.runtimeId, input.deliveryPayload, input.queuedAt],
        );

    readonly touchSession = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions SET updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
            [input.updatedAt, input.scopeKey, input.sessionId],
        );

    readonly findTurn = (scopeKey: string, sessionId: string, turnId: string): TurnRecord | undefined =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
                [scopeKey, sessionId, turnId],
            ),
        )[0];

    readonly findCommandRuntime = (
        scopeKey: string,
        sessionId: string,
        commandId: string,
    ): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
               FROM turns c
               JOIN session_bindings b
                 ON b.scope_key = c.scope_key AND b.session_id = c.session_id
                AND b.binding_id = c.binding_id
               WHERE c.scope_key = ? AND c.session_id = ? AND c.command_id = ?`,
                [scopeKey, sessionId, commandId],
            ),
        )[0];

    readonly findAttemptRuntime = (
        scopeKey: string,
        sessionId: string,
        attemptId: string,
    ): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
               FROM attempts a
               JOIN session_bindings b
                 ON b.scope_key = a.scope_key AND b.session_id = a.session_id
                AND b.binding_id = a.binding_id
               WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?`,
                [scopeKey, sessionId, attemptId],
            ),
        )[0];

    readonly findTurnAttempt = (
        scopeKey: string,
        sessionId: string,
        commandId: string,
    ): TurnAttemptRecord | undefined =>
        decodeStorageRows(
            TurnAttemptRecordSchema,
            this.#database.query(
                `SELECT attempt_id, state FROM turns
           WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
                [scopeKey, sessionId, commandId],
            ),
        )[0];

    readonly findDuplicateEvent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly eventId: string;
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceSeq: string;
    }): CommittedEventRecord | undefined =>
        decodeStorageRows(
            CommittedEventRecordSchema,
            this.#database.query(
                `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
         AND (event_id = ? OR
              (source_kind = ? AND source_id = ? AND source_seq = ?))`,
                [input.scopeKey, input.sessionId, input.eventId, input.sourceKind, input.sourceId, input.sourceSeq],
            ),
        )[0];

    readonly findEventReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly eventId: string;
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceSeq: string;
    }): EventReceiptRecord | undefined =>
        decodeStorageRows(
            EventReceiptRecordSchema,
            this.#database.query(
                `SELECT event_id, payload_hash, source_kind, source_id, source_seq,
                        sequence_number, recorded_at
                   FROM session_event_receipts
                  WHERE scope_key = ? AND session_id = ?
                    AND (event_id = ? OR (source_kind = ? AND source_id = ?))`,
                [input.scopeKey, input.sessionId, input.eventId, input.sourceKind, input.sourceId],
            ),
        ).find(
            (receipt) =>
                receipt.event_id === input.eventId ||
                (receipt.source_kind === input.sourceKind &&
                    receipt.source_id === input.sourceId &&
                    receipt.source_seq === input.sourceSeq),
        );

    readonly findLatestSourceSequence = (
        scopeKey: string,
        sessionId: string,
        sourceKind: string,
        sourceId: string,
    ): SourceSequenceRecord | undefined =>
        decodeStorageRows(
            SourceSequenceRecordSchema,
            this.#database.query(
                `SELECT source_seq
                   FROM (
                       SELECT source_seq
                         FROM session_events
                        WHERE scope_key = ? AND session_id = ? AND source_kind = ? AND source_id = ?
                       UNION ALL
                       SELECT source_seq
                         FROM session_event_receipts
                        WHERE scope_key = ? AND session_id = ? AND source_kind = ? AND source_id = ?
                   )
                  ORDER BY length(source_seq) DESC, source_seq DESC
                  LIMIT 1`,
                [scopeKey, sessionId, sourceKind, sourceId, scopeKey, sessionId, sourceKind, sourceId],
            ),
        )[0];

    readonly insertHotEvent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly sequenceNumber: number;
        readonly eventId: string;
        readonly payloadHash: string;
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceSeq: string;
        readonly payload: string | null;
        readonly recordedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO session_events (
           scope_key, session_id, sequence_number, event_id, payload_hash,
           source_kind, source_id, source_seq, payload, archive_segment_id,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.sequenceNumber,
                input.eventId,
                input.payloadHash,
                input.sourceKind,
                input.sourceId,
                input.sourceSeq,
                input.payload,
                "",
                input.recordedAt,
            ],
        );

    readonly advanceEventSequence = (input: {
        readonly nextSequence: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET next_sequence = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
            [input.nextSequence, input.updatedAt, input.scopeKey, input.sessionId],
        );

    readonly findBinding = (scopeKey: string, sessionId: string, bindingId: string): SessionBindingRecord | undefined =>
        decodeStorageRows(
            SessionBindingRecordSchema,
            this.#database.query(
                `SELECT * FROM session_bindings
         WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
                [scopeKey, sessionId, bindingId],
            ),
        )[0];

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

    readonly findBindingTurn = (scopeKey: string, sessionId: string, bindingId: string): RecordPresence | undefined =>
        decodeStorageRows(
            RecordPresenceSchema,
            this.#database.query(
                `SELECT 1 FROM turns
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?
             LIMIT 1`,
                [scopeKey, sessionId, bindingId],
            ),
        )[0];

    readonly updateBinding = (input: {
        readonly runtimeId: string;
        readonly agentRef: string;
        readonly workspaceRef: string;
        readonly configRevision: number;
        readonly createdAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly bindingId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE session_bindings
             SET runtime_id = ?, agent_ref = ?, workspace_ref = ?,
                 config_revision = ?, created_at = ?
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
            [
                input.runtimeId,
                input.agentRef,
                input.workspaceRef,
                input.configRevision,
                input.createdAt,
                input.scopeKey,
                input.sessionId,
                input.bindingId,
            ],
        );

    readonly setDefaultBinding = (input: {
        readonly bindingId: string;
        readonly runtimeId: string;
        readonly agentId: string;
        readonly directoryId: string;
        readonly configRevision: number;
        readonly bindingCreatedAt: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET binding_id = ?, runtime_id = ?, agent_id = ?, directory_id = ?,
             config_revision = ?, binding_created_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
            [
                input.bindingId,
                input.runtimeId,
                input.agentId,
                input.directoryId,
                input.configRevision,
                input.bindingCreatedAt,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
            ],
        );

    readonly markRuntimeAttemptsIndeterminate = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly scopeKey2: string;
        readonly runtimeId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ?
           AND state IN ('dispatching', 'running', 'waiting_input')
           AND (session_id, binding_id) IN (
             SELECT session_id, binding_id FROM session_bindings
             WHERE scope_key = ? AND runtime_id = ?
           )`,
            [input.updatedAt, input.scopeKey, input.scopeKey2, input.runtimeId],
        );

    readonly markIndeterminateTurns = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly scopeKey2: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ? AND state IN ('queued', 'running')
           AND turn_id IN (
             SELECT turn_id FROM attempts
             WHERE scope_key = ? AND state = 'indeterminate'
           )`,
            [input.updatedAt, input.scopeKey, input.scopeKey2],
        );
    readonly findTurnRuntimeRecord = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): TurnRuntimeRecord | undefined =>
        decodeStorageRows(
            TurnRuntimeRecordSchema,
            this.#database.query(
                `SELECT t.*, b.runtime_id
         FROM turns t
         INNER JOIN session_bindings b
           ON b.scope_key = t.scope_key AND b.session_id = t.session_id
          AND b.binding_id = t.binding_id
         WHERE t.scope_key = ? AND t.session_id = ? AND t.turn_id = ?`,
                [input.scopeKey, input.sessionId, input.turnId],
            ),
        )[0];
    readonly findCommandReceiptResult = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandKind: string;
        readonly idempotencyKey: string;
    }) =>
        decodeStorageRows(
            CommandResultReceiptRecordSchema,
            this.#database.query(
                `SELECT request_hash, result_id FROM command_receipts
         WHERE scope_key = ? AND session_id = ?
           AND command_kind = ? AND idempotency_key = ?`,
                [input.scopeKey, input.sessionId, input.commandKind, input.idempotencyKey],
            ),
        )[0];
}
