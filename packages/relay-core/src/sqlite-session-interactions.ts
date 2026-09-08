import {
  type Attempt,
  decodeInteractionResponse,
  type InteractionResponse,
  type PendingWork,
} from "@moxt-ai/mobius-protocol";
import { sha256 } from "./session-archive-codec.ts";
import {
  type InteractionResponseAcceptance,
  type PendingDaemonDelivery,
  type ProjectScope,
  SessionRuntimeError,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { rowNullableString, rowString } from "./sqlite-row.ts";
import type { SqliteSessionQueries } from "./sqlite-session-queries.ts";
import {
  interactionFromRow,
  pendingWorkFromRow,
  scopeKey,
  validateDomainIdentifier,
  validateLimit,
  validateTimestamp,
} from "./sqlite-session-records.ts";
import type { SqliteSessionStore } from "./sqlite-session-store.ts";

export class SqliteSessionInteractions {
  readonly #database: SessionSqlDatabase;
  readonly #queries: SqliteSessionQueries;
  readonly #store: SqliteSessionStore;

  constructor(
    database: SessionSqlDatabase,
    queries: SqliteSessionQueries,
    store: SqliteSessionStore,
  ) {
    this.#database = database;
    this.#queries = queries;
    this.#store = store;
  }
  readonly acceptInteractionResponse = async (
    scope: ProjectScope,
    sessionId: string,
    interactionId: string,
    responderId: string,
    response: InteractionResponse,
    deliveryPayload: string,
    now: number,
    signal: AbortSignal,
  ): Promise<InteractionResponseAcceptance> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(interactionId, "interaction");
    validateDomainIdentifier(responderId, "responder");
    if (
      deliveryPayload.length === 0 ||
      new TextEncoder().encode(deliveryPayload).byteLength > 8 * 1024 * 1024
    ) {
      throw new SessionRuntimeError(
        "interaction_conflict",
        "The Interaction response delivery payload is invalid",
      );
    }
    let validatedResponse: InteractionResponse;
    try {
      validatedResponse = decodeInteractionResponse(response);
    } catch (cause) {
      throw new SessionRuntimeError(
        "interaction_conflict",
        "The Interaction response is invalid",
        { cause },
      );
    }
    const key = scopeKey(scope);
    this.#store.requireActiveSessionRow(scope, sessionId, now);
    const encodedResponse = JSON.stringify(validatedResponse);
    const workDigest = await sha256(
      new TextEncoder().encode(
        `${key}\u0000${sessionId}\u0000${interactionId}`,
      ),
    );
    const workId = `work_${workDigest.slice(0, 32)}`;
    signal.throwIfAborted();
    return this.#database.transaction(() => {
      const interaction = this.#database.query(
        `SELECT i.*, b.runtime_id
         FROM interactions i
         JOIN attempts a
           ON a.scope_key = i.scope_key AND a.session_id = i.session_id
          AND a.attempt_id = i.attempt_id
         JOIN session_bindings b
           ON b.scope_key = a.scope_key AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE i.scope_key = ? AND i.session_id = ? AND i.interaction_id = ?`,
        [key, sessionId, interactionId],
      )[0];
      if (interaction === undefined) {
        throw new SessionRuntimeError(
          "interaction_not_found",
          "The Interaction does not exist",
        );
      }
      if (
        interactionFromRow(interaction).request.kind !== validatedResponse.kind
      ) {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "The response kind does not match the Interaction request",
        );
      }
      const state = rowString(interaction, "state");
      if (state === "responded") {
        const work = this.#database.query(
          `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
          [key, sessionId, interactionId],
        )[0];
        if (
          rowNullableString(interaction, "response_json") !== encodedResponse ||
          rowNullableString(interaction, "responder_id") !== responderId ||
          work === undefined ||
          rowNullableString(work, "delivery_payload") !== deliveryPayload
        ) {
          throw new SessionRuntimeError(
            "interaction_conflict",
            "The Interaction response identity was reused with different input",
          );
        }
        return {
          duplicate: true,
          interaction: interactionFromRow(interaction),
          pendingWork: pendingWorkFromRow(work, scope),
        };
      }
      if (state !== "pending") {
        throw new SessionRuntimeError(
          "interaction_conflict",
          "The Interaction no longer accepts a response",
        );
      }
      this.#database.run(
        `UPDATE interactions
         SET state = 'responded', response_json = ?, responder_id = ?,
             responded_at = ?
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [encodedResponse, responderId, now, key, sessionId, interactionId],
      );
      this.#database.run(
        `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           interaction_id, delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'interaction_response', ?, ?, ?, 'pending', ?)`,
        [
          key,
          sessionId,
          workId,
          rowString(interaction, "runtime_id"),
          interactionId,
          deliveryPayload,
          now,
        ],
      );
      const updatedInteraction = this.#database.query(
        `SELECT * FROM interactions
         WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
        [key, sessionId, interactionId],
      )[0];
      const pendingWork = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (updatedInteraction === undefined || pendingWork === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The Interaction response was not persisted atomically",
        );
      }
      return {
        duplicate: false,
        interaction: interactionFromRow(updatedInteraction),
        pendingWork: pendingWorkFromRow(pendingWork, scope),
      };
    });
  };

  readonly listPendingDaemonDeliveries = async (
    scope: ProjectScope,
    runtimeId: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly PendingDaemonDelivery[]> => {
    signal.throwIfAborted();
    scopeKey(scope);
    validateDomainIdentifier(runtimeId, "runtime");
    validateLimit(limit);
    return this.#database
      .query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND runtime_id = ?
           AND work_kind IN ('dispatch', 'interaction_response')
           AND state IN ('pending', 'retryable')
         ORDER BY queued_at, work_id
         LIMIT ?`,
        [scopeKey(scope), runtimeId, limit],
      )
      .map((row) => {
        const workKind = rowString(row, "work_kind");
        const interactionId = rowNullableString(row, "interaction_id");
        const payload = rowNullableString(row, "delivery_payload");
        if (
          payload === null ||
          (workKind === "interaction_response" && interactionId === null)
        ) {
          throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The pending daemon delivery is incomplete",
          );
        }
        return {
          interactionId,
          payload,
          pendingWork: pendingWorkFromRow(row, scope),
        };
      });
  };

  readonly markPendingWorkCompleted = async (
    scope: ProjectScope,
    sessionId: string,
    workId: string,
    now: number,
    signal: AbortSignal,
  ): Promise<PendingWork> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(workId, "pending work");
    this.#store.requireActiveSessionRow(scope, sessionId, now);
    const key = scopeKey(scope);
    return this.#database.transaction(() => {
      const work = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (work === undefined) {
        throw new SessionRuntimeError(
          "pending_work_not_found",
          "The PendingWork item does not exist",
        );
      }
      const state = rowString(work, "state");
      if (state !== "completed") {
        if (state === "failed") {
          throw new SessionRuntimeError(
            "session_conflict",
            "The failed PendingWork item cannot complete",
          );
        }
        this.#database.run(
          `UPDATE pending_work
           SET state = 'completed', completed_at = ?, error_code = NULL,
               error_message = NULL
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
          [now, key, sessionId, workId],
        );
      }
      const updated = this.#database.query(
        `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
        [key, sessionId, workId],
      )[0];
      if (updated === undefined) {
        throw new SessionRuntimeError(
          "session_storage_unavailable",
          "The completed PendingWork item disappeared",
        );
      }
      return pendingWorkFromRow(updated, scope);
    });
  };

  readonly reconcileAttempt = async (
    scope: ProjectScope,
    runtimeId: string,
    sessionId: string,
    attemptId: string,
    outcome: import("./session-runtime.ts").AttemptReconciliationOutcome,
    now: number,
    signal: AbortSignal,
  ): Promise<Attempt> => {
    signal.throwIfAborted();
    validateTimestamp(now);
    validateDomainIdentifier(runtimeId, "runtime");
    validateDomainIdentifier(sessionId, "session");
    validateDomainIdentifier(attemptId, "attempt");
    this.#store.requireActiveSessionRow(scope, sessionId, now);
    const key = scopeKey(scope);
    this.#database.transaction(() => {
      const attempt = this.#database.query(
        `SELECT a.* FROM attempts a
         JOIN session_bindings b
           ON b.scope_key = a.scope_key
          AND b.session_id = a.session_id
          AND b.binding_id = a.binding_id
         WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?
           AND b.runtime_id = ?`,
        [key, sessionId, attemptId, runtimeId],
      )[0];
      if (
        attempt === undefined ||
        rowString(attempt, "state") !== "indeterminate"
      ) {
        throw new SessionRuntimeError(
          "session_conflict",
          "Only the owning Runtime can reconcile an indeterminate Attempt",
        );
      }
      const turnId = rowString(attempt, "turn_id");
      if (outcome.kind === "running") {
        this.#database.run(
          `UPDATE attempts SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns SET state = 'running', updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, key, sessionId, turnId],
        );
        return;
      }
      if (outcome.kind === "succeeded") {
        this.#database.run(
          `UPDATE attempts
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, outcome.stopReason, now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns
           SET state = 'succeeded', completed_at = ?, stop_reason = ?,
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, outcome.stopReason, now, key, sessionId, turnId],
        );
        return;
      }
      if (outcome.kind === "cancelled") {
        this.#database.run(
          `UPDATE attempts
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
          [now, now, key, sessionId, attemptId],
        );
        this.#database.run(
          `UPDATE turns
           SET state = 'cancelled', completed_at = ?, stop_reason = 'cancelled',
               updated_at = ?
           WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
          [now, now, key, sessionId, turnId],
        );
        return;
      }
      this.#database.run(
        `UPDATE attempts
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
        [
          now,
          outcome.error.code,
          outcome.error.message,
          now,
          key,
          sessionId,
          attemptId,
        ],
      );
      this.#database.run(
        `UPDATE turns
         SET state = 'failed', completed_at = ?, error_code = ?,
             error_message = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
        [
          now,
          outcome.error.code,
          outcome.error.message,
          now,
          key,
          sessionId,
          turnId,
        ],
      );
    });
    signal.throwIfAborted();
    return await this.#queries.readAttempt(scope, sessionId, attemptId, signal);
  };
}
