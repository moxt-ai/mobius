import {
    type AttemptRecord,
    AttemptRecordSchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type InteractionRuntimeRecord,
    InteractionRuntimeRecordSchema,
    type PendingWorkRecord,
    PendingWorkRecordSchema,
} from "../../entity/session/session-records.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";

export class SessionInteractionsStorage {
    readonly #database: SessionSqlDatabase;
    constructor(database: SessionSqlDatabase) {
        this.#database = database;
    }

    readonly findInteractionRuntime = (
        scopeKey: string,
        sessionId: string,
        interactionId: string,
    ): InteractionRuntimeRecord | undefined =>
        decodeStorageRows(
            InteractionRuntimeRecordSchema,
            this.#database.query(
                `SELECT i.*, b.runtime_id
         FROM interactions i
         JOIN attempts a
           ON a.scope_key = i.scope_key AND a.session_id = i.session_id
          AND a.attempt_id = i.attempt_id
         JOIN session_bindings b
           ON b.scope_key = a.scope_key AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE i.scope_key = ? AND i.session_id = ? AND i.interaction_id = ?`,
                [scopeKey, sessionId, interactionId],
            ),
        )[0];

    readonly findInteractionDelivery = (
        scopeKey: string,
        sessionId: string,
        interactionId: string | null,
    ): PendingWorkRecord | undefined =>
        decodeStorageRows(
            PendingWorkRecordSchema,
            this.#database.query(
                `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
                [scopeKey, sessionId, interactionId],
            ),
        )[0];

    readonly recordInteractionResponse = (input: {
        readonly responseJson: string | null;
        readonly responderId: string | null;
        readonly respondedAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE interactions
         SET state = 'responded', response_json = ?, responder_id = ?,
             responded_at = ?
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
            [
                input.responseJson,
                input.responderId,
                input.respondedAt,
                input.scopeKey,
                input.sessionId,
                input.interactionId,
            ],
        );

    readonly insertInteractionDelivery = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly workId: string;
        readonly runtimeId: string;
        readonly interactionId: string | null;
        readonly deliveryPayload: string | null;
        readonly queuedAt: number;
    }): { readonly changes: number } =>
        this.#database.run(
            `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           interaction_id, delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'interaction_response', ?, ?, ?, 'pending', ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.workId,
                input.runtimeId,
                input.interactionId,
                input.deliveryPayload,
                input.queuedAt,
            ],
        );

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

    readonly findPendingWork = (scopeKey: string, sessionId: string, workId: string): PendingWorkRecord | undefined =>
        decodeStorageRows(
            PendingWorkRecordSchema,
            this.#database.query(
                `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                [scopeKey, sessionId, workId],
            ),
        )[0];

    readonly listDaemonDeliveries = (input: {
        readonly scopeKey: string;
        readonly runtimeId: string;
        readonly limit: number;
    }): readonly PendingWorkRecord[] =>
        decodeStorageRows(
            PendingWorkRecordSchema,
            this.#database.query(
                `SELECT * FROM pending_work
         WHERE scope_key = ? AND runtime_id = ?
           AND work_kind IN ('dispatch', 'interaction_response')
           AND state IN ('pending', 'retryable')
         ORDER BY queued_at, work_id
         LIMIT ?`,
                [input.scopeKey, input.runtimeId, input.limit],
            ),
        );

    readonly completePendingWork = (input: {
        readonly completedAt: number | null;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly workId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE pending_work
           SET state = 'completed', completed_at = ?, error_code = NULL,
               error_message = NULL
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
            [input.completedAt, input.scopeKey, input.sessionId, input.workId],
        );

    readonly findRuntimeAttempt = (
        scopeKey: string,
        sessionId: string,
        attemptId: string,
        runtimeId: string,
    ): AttemptRecord | undefined =>
        decodeStorageRows(
            AttemptRecordSchema,
            this.#database.query(
                `SELECT a.* FROM attempts a
         JOIN session_bindings b
           ON b.scope_key = a.scope_key
          AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?
           AND b.runtime_id = ?`,
                [scopeKey, sessionId, attemptId, runtimeId],
            ),
        )[0];

    readonly resumeAttempt = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [input.updatedAt, input.scopeKey, input.sessionId, input.attemptId],
        );

    readonly resumeTurn = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
            [input.updatedAt, input.scopeKey, input.sessionId, input.turnId],
        );

    readonly succeedAttempt = (input: {
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [input.completedAt, input.stopReason, input.updatedAt, input.scopeKey, input.sessionId, input.attemptId],
        );

    readonly succeedTurn = (input: {
        readonly completedAt: number | null;
        readonly stopReason: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
            [input.completedAt, input.stopReason, input.updatedAt, input.scopeKey, input.sessionId, input.turnId],
        );

    readonly cancelAttempt = (input: {
        readonly completedAt: number | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [input.completedAt, input.updatedAt, input.scopeKey, input.sessionId, input.attemptId],
        );

    readonly cancelTurn = (input: {
        readonly completedAt: number | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
            [input.completedAt, input.updatedAt, input.scopeKey, input.sessionId, input.turnId],
        );

    readonly failAttempt = (input: {
        readonly completedAt: number | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE attempts
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [
                input.completedAt,
                input.errorCode,
                input.errorMessage,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.attemptId,
            ],
        );

    readonly failTurn = (input: {
        readonly completedAt: number | null;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE turns
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
            [
                input.completedAt,
                input.errorCode,
                input.errorMessage,
                input.updatedAt,
                input.scopeKey,
                input.sessionId,
                input.turnId,
            ],
        );
}
