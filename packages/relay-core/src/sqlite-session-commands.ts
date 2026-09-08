import {
    type CommittedSessionEvent,
    decodeCommittedSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
    encodeCommittedSessionEvent,
    encodeSessionCancelCommand,
    encodeSessionEventEnvelope,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    type SessionPromptCommand,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import { sha256 } from "./session-archive-codec.ts";
import {
    type CommittedEventResult,
    type CreateSessionBindingRequest,
    CreateSessionRequest,
    type ProjectScope,
    SessionRuntimeError,
    type SessionSummary,
    type TurnAcceptance,
    type TurnCancellationAcceptance,
} from "./session-runtime.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";
import { rowNullableString, rowNumber, rowString } from "./sqlite-row.ts";
import type { SqliteSessionArchive } from "./sqlite-session-archive.ts";
import type { SqliteSessionEventProjector } from "./sqlite-session-event-projector.ts";
import type { SqliteSessionLifecycle } from "./sqlite-session-lifecycle.ts";
import {
    committedFromRow,
    DEFAULT_CONTENT_LIMIT_BYTES,
    DEFAULT_HOT_EVENT_LIMIT,
    DEFAULT_RETENTION_MILLISECONDS,
    eventCursor,
    pendingWorkFromRow,
    scopeKey,
    summaryFromRow,
    turnFromRow,
    validateDomainIdentifier,
    validateTimestamp,
} from "./sqlite-session-records.ts";
import type { SqliteSessionStore } from "./sqlite-session-store.ts";

export class SqliteSessionCommands {
    readonly #archive: SqliteSessionArchive;
    readonly #database: SessionSqlDatabase;
    readonly #eventProjector: SqliteSessionEventProjector;
    readonly #lifecycle: SqliteSessionLifecycle;
    readonly #store: SqliteSessionStore;

    constructor(
        database: SessionSqlDatabase,
        archive: SqliteSessionArchive,
        eventProjector: SqliteSessionEventProjector,
        lifecycle: SqliteSessionLifecycle,
        store: SqliteSessionStore,
    ) {
        this.#archive = archive;
        this.#database = database;
        this.#eventProjector = eventProjector;
        this.#lifecycle = lifecycle;
        this.#store = store;
    }

    readonly acceptTurn = async (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionPromptCommand,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        let validatedCommand: SessionPromptCommand;
        try {
            validatedCommand = decodeSessionPromptCommand(JSON.stringify(command));
        } catch (cause) {
            throw new SessionRuntimeError("session_conflict", "The session command is invalid", { cause });
        }
        if (this.#store.sessionRow(scope, validatedCommand.sessionId) === null) {
            await this.#lifecycle.createSession(
                scope,
                new CreateSessionRequest(
                    validatedCommand.sessionId,
                    runtimeId,
                    validatedCommand.agentId,
                    validatedCommand.bindingId,
                    validatedCommand.directoryId,
                    {
                        contentLimitBytes: DEFAULT_CONTENT_LIMIT_BYTES,
                        hotEventLimit: DEFAULT_HOT_EVENT_LIMIT,
                        idempotencyRetentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
                        level: "full",
                        retentionMilliseconds: DEFAULT_RETENTION_MILLISECONDS,
                    },
                ),
                now,
                signal,
            );
        }
        const session = this.#store.requireActiveSessionRow(scope, validatedCommand.sessionId, now);
        if (rowString(session, "runtime_id") !== runtimeId) {
            throw new SessionRuntimeError("session_access_denied", "The session is bound to another runtime");
        }
        const key = scopeKey(scope);
        const encodedCommand = JSON.stringify(validatedCommand);
        const requestHash = await sha256(new TextEncoder().encode(encodedCommand));
        const binding = this.#database.query(
            `SELECT binding_id FROM session_bindings
       WHERE scope_key = ? AND session_id = ? AND binding_id = ?
         AND runtime_id = ? AND agent_ref = ? AND workspace_ref = ?`,
            [
                key,
                validatedCommand.sessionId,
                validatedCommand.bindingId,
                runtimeId,
                validatedCommand.agentId,
                validatedCommand.directoryId,
            ],
        )[0];
        if (binding === undefined) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Turn binding is not registered for this Session and Runtime",
            );
        }
        return this.#database.transaction(() => {
            const duplicate = this.#database.query(
                `SELECT t.* FROM command_receipts r
         JOIN turns t
           ON t.scope_key = r.scope_key AND t.session_id = r.session_id
          AND t.turn_id = r.result_id
         WHERE r.scope_key = ? AND r.session_id = ?
           AND r.command_kind = ? AND r.idempotency_key = ?`,
                [key, validatedCommand.sessionId, validatedCommand.kind, validatedCommand.commandId],
            )[0];
            if (duplicate !== undefined) {
                if (rowString(duplicate, "request_hash") !== requestHash) {
                    throw new SessionRuntimeError(
                        "idempotency_conflict",
                        "The idempotency key was reused with different Turn input",
                    );
                }
                const state = rowString(duplicate, "state");
                if (
                    state !== "queued" &&
                    state !== "running" &&
                    state !== "succeeded" &&
                    state !== "failed" &&
                    state !== "cancelled" &&
                    state !== "indeterminate"
                ) {
                    throw new SessionRuntimeError("session_storage_unavailable", "The command state is invalid");
                }
                const turn = turnFromRow(duplicate);
                const pending = this.#database.query(
                    `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                    [key, validatedCommand.sessionId, `dispatch_${turn.turnId}`],
                )[0];
                return {
                    kind: "duplicate",
                    pendingWork: pending === undefined ? null : pendingWorkFromRow(pending, scope),
                    state,
                    turn,
                };
            }
            const active = this.#database.query(
                `SELECT command_id FROM turns
         WHERE scope_key = ? AND session_id = ?
           AND state IN ('queued', 'running', 'indeterminate')
         LIMIT 1`,
                [key, validatedCommand.sessionId],
            )[0];
            if (active !== undefined) {
                throw new SessionRuntimeError("session_busy", "The session already has an active command");
            }
            const turnId = `turn_${crypto.randomUUID()}`;
            const workId = `dispatch_${turnId}`;
            this.#database.run(
                `INSERT INTO turns (
           scope_key, session_id, command_id, turn_id, binding_id,
           idempotency_key, request_hash, command_json, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
                [
                    key,
                    validatedCommand.sessionId,
                    validatedCommand.commandId,
                    turnId,
                    validatedCommand.bindingId,
                    validatedCommand.commandId,
                    requestHash,
                    encodedCommand,
                    now,
                    now,
                ],
            );
            this.#database.run(
                `INSERT INTO command_receipts (
           scope_key, session_id, command_kind, idempotency_key,
           request_hash, result_id, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    key,
                    validatedCommand.sessionId,
                    validatedCommand.kind,
                    validatedCommand.commandId,
                    requestHash,
                    turnId,
                    now,
                ],
            );
            this.#database.run(
                `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
                [key, validatedCommand.sessionId, workId, runtimeId, encodedCommand, now],
            );
            this.#database.run(
                `UPDATE sessions SET updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
                [now, key, validatedCommand.sessionId],
            );
            const accepted = this.#database.query(
                `SELECT * FROM turns
         WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
                [key, validatedCommand.sessionId, turnId],
            )[0];
            if (accepted === undefined) {
                throw new SessionRuntimeError("session_storage_unavailable", "The accepted Turn could not be read");
            }
            const pending = this.#database.query(
                `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                [key, validatedCommand.sessionId, workId],
            )[0];
            if (pending === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The Turn dispatch was not committed atomically",
                );
            }
            return {
                kind: "accepted",
                pendingWork: pendingWorkFromRow(pending, scope),
                turn: turnFromRow(accepted),
            };
        });
    };

    readonly acceptTurnCancellation = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnCancellationAcceptance> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(turnId, "turn");
        validateDomainIdentifier(idempotencyKey, "idempotency key");
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        const requestPayload = JSON.stringify({ sessionId, turnId });
        const requestHash = await sha256(new TextEncoder().encode(requestPayload));
        signal.throwIfAborted();
        return this.#database.transaction(() => {
            const turnRow = this.#database.query(
                `SELECT t.*, b.runtime_id
         FROM turns t
         INNER JOIN session_bindings b
           ON b.scope_key = t.scope_key AND b.session_id = t.session_id
          AND b.binding_id = t.binding_id
         WHERE t.scope_key = ? AND t.session_id = ? AND t.turn_id = ?`,
                [key, sessionId, turnId],
            )[0];
            if (turnRow === undefined) {
                throw new SessionRuntimeError("session_not_found", "The Turn does not exist");
            }
            if (rowString(turnRow, "runtime_id") !== runtimeId) {
                throw new SessionRuntimeError(
                    "session_access_denied",
                    "The Runtime does not own the Turn's immutable binding",
                );
            }
            const duplicate = this.#database.query(
                `SELECT request_hash, result_id FROM command_receipts
         WHERE scope_key = ? AND session_id = ?
           AND command_kind = ? AND idempotency_key = ?`,
                [key, sessionId, SESSION_CANCEL_KIND, idempotencyKey],
            )[0];
            if (duplicate !== undefined) {
                if (rowString(duplicate, "request_hash") !== requestHash) {
                    throw new SessionRuntimeError(
                        "idempotency_conflict",
                        "The idempotency key was reused for another Turn cancellation",
                    );
                }
                const pending = this.#database.query(
                    `SELECT * FROM pending_work
           WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                    [key, sessionId, rowString(duplicate, "result_id")],
                )[0];
                if (pending === undefined) {
                    throw new SessionRuntimeError(
                        "session_storage_unavailable",
                        "The accepted Turn cancellation is incomplete",
                    );
                }
                return {
                    duplicate: true,
                    pendingWork: pendingWorkFromRow(pending, scope),
                    turn: turnFromRow(turnRow),
                };
            }
            const state = rowString(turnRow, "state");
            if (state !== "queued" && state !== "running" && state !== "indeterminate") {
                throw new SessionRuntimeError("session_conflict", "The Turn no longer accepts cancellation");
            }
            const workId = `cancel_${crypto.randomUUID()}`;
            const deliveryPayload = encodeSessionCancelCommand({
                commandId: rowString(turnRow, "command_id"),
                kind: SESSION_CANCEL_KIND,
                sessionId,
            });
            this.#database.run(
                `INSERT INTO command_receipts (
           scope_key, session_id, command_kind, idempotency_key,
           request_hash, result_id, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [key, sessionId, SESSION_CANCEL_KIND, idempotencyKey, requestHash, workId, now],
            );
            this.#database.run(
                `INSERT INTO pending_work (
           scope_key, session_id, work_id, work_kind, runtime_id,
           delivery_payload, state, queued_at
         ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
                [key, sessionId, workId, runtimeId, deliveryPayload, now],
            );
            const pending = this.#database.query(
                `SELECT * FROM pending_work
         WHERE scope_key = ? AND session_id = ? AND work_id = ?`,
                [key, sessionId, workId],
            )[0];
            if (pending === undefined) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The Turn cancellation was not committed atomically",
                );
            }
            return {
                duplicate: false,
                pendingWork: pendingWorkFromRow(pending, scope),
                turn: turnFromRow(turnRow),
            };
        });
    };

    readonly commitEvent = async (
        scope: ProjectScope,
        runtimeId: string,
        envelope: SessionEventEnvelope,
        now: number,
        signal: AbortSignal,
    ): Promise<CommittedEventResult> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        let validatedEnvelope: SessionEventEnvelope;
        try {
            validatedEnvelope = decodeSessionEventEnvelope(encodeSessionEventEnvelope(envelope));
        } catch (cause) {
            throw new SessionRuntimeError("session_conflict", "The session event envelope is invalid", { cause });
        }
        const decoded = validateSessionEventEnvelope(validatedEnvelope);
        const session = this.#store.requireActiveSessionRow(scope, validatedEnvelope.sessionId, now);
        const key = scopeKey(scope);
        const sourceKind = validatedEnvelope.source.kind;
        if ("commandId" in decoded && sourceKind !== "attempt") {
            throw new SessionRuntimeError(
                "event_source_conflict",
                "An execution event requires an Attempt source identity",
            );
        }
        let owningRuntimeId: string;
        if (sourceKind === "attempt") {
            const ownership =
                decoded.kind === SESSION_STARTED_KIND || decoded.kind === SESSION_FAILED_KIND
                    ? this.#database.query(
                          `SELECT b.runtime_id
               FROM turns c
               JOIN session_bindings b
                 ON b.scope_key = c.scope_key AND b.session_id = c.session_id
                AND b.binding_id = c.binding_id
               WHERE c.scope_key = ? AND c.session_id = ? AND c.command_id = ?`,
                          [key, validatedEnvelope.sessionId, decoded.commandId],
                      )[0]
                    : this.#database.query(
                          `SELECT b.runtime_id
               FROM attempts a
               JOIN session_bindings b
                 ON b.scope_key = a.scope_key AND b.session_id = a.session_id
                AND b.binding_id = a.binding_id
               WHERE a.scope_key = ? AND a.session_id = ? AND a.attempt_id = ?`,
                          [key, validatedEnvelope.sessionId, validatedEnvelope.source.attemptId],
                      )[0];
            if (ownership === undefined) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "The event references an unknown Attempt source",
                );
            }
            owningRuntimeId = rowString(ownership, "runtime_id");
        } else if ("commandId" in decoded) {
            const ownership = this.#database.query(
                `SELECT b.runtime_id
         FROM turns c
         JOIN session_bindings b
           ON b.scope_key = c.scope_key AND b.session_id = c.session_id
          AND b.binding_id = c.binding_id
         WHERE c.scope_key = ? AND c.session_id = ? AND c.command_id = ?`,
                [key, validatedEnvelope.sessionId, decoded.commandId],
            )[0];
            owningRuntimeId =
                ownership === undefined ? rowString(session, "runtime_id") : rowString(ownership, "runtime_id");
        } else {
            owningRuntimeId = rowString(session, "runtime_id");
        }
        if (owningRuntimeId !== runtimeId) {
            throw new SessionRuntimeError(
                "session_access_denied",
                "The Runtime does not own the event's immutable binding",
            );
        }
        const sourceId = sourceKind === "attempt" ? validatedEnvelope.source.attemptId : runtimeId;
        const sourceSeq = validatedEnvelope.source.sourceSeq;
        const payloadHash = await sha256(new TextEncoder().encode(validatedEnvelope.payload));
        if (sourceKind === "attempt") {
            if (decoded.kind === SESSION_STARTED_KIND && decoded.attemptId !== sourceId) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "The event source does not match the Attempt identity",
                );
            }
            if (decoded.kind !== SESSION_STARTED_KIND && "commandId" in decoded) {
                const command = this.#database.query(
                    `SELECT attempt_id, state FROM turns
           WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
                    [key, validatedEnvelope.sessionId, decoded.commandId],
                )[0];
                const existingAttemptId = command === undefined ? null : rowNullableString(command, "attempt_id");
                if (
                    command === undefined ||
                    (existingAttemptId === null
                        ? decoded.kind !== SESSION_FAILED_KIND || rowString(command, "state") !== "queued"
                        : existingAttemptId !== sourceId)
                ) {
                    throw new SessionRuntimeError(
                        "event_source_conflict",
                        "The event source does not own the referenced Turn",
                    );
                }
            }
        }
        const duplicate = this.#database.query(
            `SELECT sequence_number, event_id, payload_hash, source_kind, source_id,
              source_seq, payload, archive_segment_id, recorded_at
       FROM session_events
       WHERE scope_key = ? AND session_id = ?
         AND (event_id = ? OR
              (source_kind = ? AND source_id = ? AND source_seq = ?))`,
            [key, validatedEnvelope.sessionId, validatedEnvelope.eventId, sourceKind, sourceId, sourceSeq],
        )[0];
        if (duplicate !== undefined) {
            if (
                rowString(duplicate, "event_id") !== validatedEnvelope.eventId ||
                rowString(duplicate, "payload_hash") !== payloadHash ||
                rowString(duplicate, "source_kind") !== sourceKind ||
                rowString(duplicate, "source_id") !== sourceId ||
                rowString(duplicate, "source_seq") !== sourceSeq
            ) {
                throw new SessionRuntimeError(
                    "event_source_conflict",
                    "A persisted event identity was reused with different content",
                );
            }
            const payload = await this.#archive.readEventPayload(scope, validatedEnvelope.sessionId, duplicate, signal);
            return {
                committed: committedFromRow(duplicate, scope, validatedEnvelope.sessionId, payload),
                duplicate: true,
            };
        }

        const prepared = this.#eventProjector.prepareEvent(session, validatedEnvelope, decoded);
        const result = this.#database.transaction<CommittedSessionEvent>(() => {
            const freshSession = this.#store.requireActiveSessionRow(scope, validatedEnvelope.sessionId, now);
            const previousSource = this.#database.query(
                `SELECT source_seq
         FROM session_events
         WHERE scope_key = ? AND session_id = ? AND source_kind = ?
           AND source_id = ?
         ORDER BY length(source_seq) DESC, source_seq DESC
         LIMIT 1`,
                [key, validatedEnvelope.sessionId, sourceKind, sourceId],
            )[0];
            const expectedSourceSeq =
                previousSource === undefined ? "1" : (BigInt(rowString(previousSource, "source_seq")) + 1n).toString();
            if (sourceSeq !== expectedSourceSeq) {
                throw new SessionRuntimeError("event_source_conflict", "The event source sequence is not contiguous");
            }
            this.#archive.assertArchiveCapacity(key, validatedEnvelope.sessionId, freshSession, prepared);
            const sequence = rowNumber(freshSession, "next_sequence");
            this.#eventProjector.applyEventProjection(
                key,
                validatedEnvelope.sessionId,
                prepared,
                sourceKind === "attempt" ? sourceId : null,
                now,
            );
            const archiveSegmentId = `segment-${validatedEnvelope.eventId}`;
            this.#archive.queueEventArchive(
                key,
                validatedEnvelope.sessionId,
                archiveSegmentId,
                validatedEnvelope.eventId,
                sequence,
                "application/json",
                prepared.payload,
            );
            if (prepared.activityDetail !== null) {
                this.#archive.queueArtifactArchive(
                    key,
                    validatedEnvelope.sessionId,
                    prepared.activityDetail.artifactId,
                    prepared.activityDetail.activityId,
                    "application/json",
                    prepared.activityDetail.payload,
                );
            }
            this.#database.run(
                `INSERT INTO session_events (
           scope_key, session_id, sequence_number, event_id, payload_hash,
           source_kind, source_id, source_seq, payload, archive_segment_id,
           recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    key,
                    validatedEnvelope.sessionId,
                    sequence,
                    validatedEnvelope.eventId,
                    payloadHash,
                    sourceKind,
                    sourceId,
                    sourceSeq,
                    prepared.payload,
                    archiveSegmentId,
                    now,
                ],
            );
            this.#database.run(
                `UPDATE sessions
         SET next_sequence = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ?`,
                [sequence + 1, now, key, validatedEnvelope.sessionId],
            );
            return {
                cursor: eventCursor(scope, validatedEnvelope.sessionId, sequence),
                eventId: validatedEnvelope.eventId,
                kind: SESSION_EVENT_COMMITTED_KIND,
                payload: prepared.payload,
                recordedAt: new Date(now).toISOString(),
                sequence: sequence.toString(),
                sessionId: validatedEnvelope.sessionId,
                source: validatedEnvelope.source,
            };
        });
        signal.throwIfAborted();
        return {
            committed: decodeCommittedSessionEvent(encodeCommittedSessionEvent(result)),
            duplicate: false,
        };
    };

    readonly setDefaultBinding = async (
        scope: ProjectScope,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(sessionId, "session");
        validateDomainIdentifier(binding.bindingId, "binding");
        validateDomainIdentifier(binding.runtimeId, "runtime");
        validateDomainIdentifier(binding.agentRef, "agent");
        validateDomainIdentifier(binding.workspaceRef, "workspace");
        if (!Number.isSafeInteger(binding.configRevision) || binding.configRevision < 0) {
            throw new SessionRuntimeError("session_conflict", "The binding configuration revision is invalid");
        }
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const key = scopeKey(scope);
        this.#database.transaction(() => {
            const existing = this.#database.query(
                `SELECT * FROM session_bindings
         WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
                [key, sessionId, binding.bindingId],
            )[0];
            let bindingCreatedAt = now;
            if (existing === undefined) {
                this.#database.run(
                    `INSERT INTO session_bindings (
             scope_key, session_id, binding_id, runtime_id, agent_ref,
             workspace_ref, config_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        key,
                        sessionId,
                        binding.bindingId,
                        binding.runtimeId,
                        binding.agentRef,
                        binding.workspaceRef,
                        binding.configRevision,
                        now,
                    ],
                );
            } else {
                const changed =
                    rowString(existing, "runtime_id") !== binding.runtimeId ||
                    rowString(existing, "agent_ref") !== binding.agentRef ||
                    rowString(existing, "workspace_ref") !== binding.workspaceRef ||
                    rowNumber(existing, "config_revision") !== binding.configRevision;
                if (changed) {
                    const used = this.#database.query(
                        `SELECT 1 FROM turns
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?
             LIMIT 1`,
                        [key, sessionId, binding.bindingId],
                    )[0];
                    if (used !== undefined) {
                        throw new SessionRuntimeError("session_conflict", "A used Session binding is immutable");
                    }
                    this.#database.run(
                        `UPDATE session_bindings
             SET runtime_id = ?, agent_ref = ?, workspace_ref = ?,
                 config_revision = ?, created_at = ?
             WHERE scope_key = ? AND session_id = ? AND binding_id = ?`,
                        [
                            binding.runtimeId,
                            binding.agentRef,
                            binding.workspaceRef,
                            binding.configRevision,
                            now,
                            key,
                            sessionId,
                            binding.bindingId,
                        ],
                    );
                } else {
                    bindingCreatedAt = rowNumber(existing, "created_at");
                }
            }
            this.#database.run(
                `UPDATE sessions
         SET binding_id = ?, runtime_id = ?, agent_id = ?, directory_id = ?,
             config_revision = ?, binding_created_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
                [
                    binding.bindingId,
                    binding.runtimeId,
                    binding.agentRef,
                    binding.workspaceRef,
                    binding.configRevision,
                    bindingCreatedAt,
                    now,
                    key,
                    sessionId,
                ],
            );
        });
        signal.throwIfAborted();
        return summaryFromRow(this.#store.requireSessionRow(scope, sessionId, true));
    };

    readonly markRuntimeDisconnected = async (
        scope: ProjectScope,
        runtimeId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly CommittedSessionEvent[]> => {
        signal.throwIfAborted();
        validateTimestamp(now);
        validateDomainIdentifier(runtimeId, "runtime");
        const key = scopeKey(scope);
        this.#database.transaction(() => {
            this.#database.run(
                `UPDATE attempts
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ?
           AND state IN ('dispatching', 'running', 'waiting_input')
           AND (session_id, binding_id) IN (
             SELECT session_id, binding_id FROM session_bindings
             WHERE scope_key = ? AND runtime_id = ?
           )`,
                [now, key, key, runtimeId],
            );
            this.#database.run(
                `UPDATE turns
         SET state = 'indeterminate', updated_at = ?
         WHERE scope_key = ? AND state IN ('queued', 'running')
           AND turn_id IN (
             SELECT turn_id FROM attempts
             WHERE scope_key = ? AND state = 'indeterminate'
           )`,
                [now, key, key],
            );
        });
        return [];
    };
}
