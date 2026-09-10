import type { SessionEventCommit } from "../../entity/do/session-event-projection.ts";
import {
    type BindingIdentity,
    BindingIdentitySchema,
    type CommandIdentity,
    CommandIdentitySchema,
    CommandResultReceiptRecordSchema,
    type CommittedEventRecord,
    CommittedEventRecordSchema,
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
            this.#archive.stageEvent({
                ...scope,
                segmentId: plan.archiveSegmentId,
                eventId: plan.eventId,
                sequence: plan.sequenceNumber,
                mediaType: "application/json",
                hotPayload: plan.payload,
            });
            if (plan.activityDetail !== null) {
                this.#archive.stageArtifact({
                    ...scope,
                    artifactId: plan.activityDetail.artifactId,
                    ownerId: plan.activityDetail.activityId,
                    mediaType: "application/json",
                    hotPayload: plan.activityDetail.payload,
                });
            }
            this.insertEvent(plan);
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
              source_seq, payload, archive_segment_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
         AND (event_id = ? OR
              (source_kind = ? AND source_id = ? AND source_seq = ?))`,
                [input.scopeKey, input.sessionId, input.eventId, input.sourceKind, input.sourceId, input.sourceSeq],
            ),
        )[0];

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
         FROM session_events
         WHERE scope_key = ? AND session_id = ? AND source_kind = ?
           AND source_id = ?
         ORDER BY length(source_seq) DESC, source_seq DESC
         LIMIT 1`,
                [scopeKey, sessionId, sourceKind, sourceId],
            ),
        )[0];

    readonly insertEvent = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly sequenceNumber: number;
        readonly eventId: string;
        readonly payloadHash: string;
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceSeq: string;
        readonly payload: string | null;
        readonly archiveSegmentId: string;
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
                input.archiveSegmentId,
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
