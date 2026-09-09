import { RequestBodyError, readBoundedUtf8Body } from "@moxt-ai/mobius-relay-core";

const MAX_INTERNAL_BODY_LENGTH = 64 * 1024;
const MAX_CONNECTION_QUEUE_DEPTH = 10_000;
const DELIVERY_CLAIM_MILLISECONDS = 60_000;
const OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

class ConnectionActorError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ConnectionActorError";
        this.status = status;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
        throw new ConnectionActorError("invalid_request", "The connection operation is invalid", 400);
    }
}

function text(value: Readonly<Record<string, unknown>>, key: string, maximum = 10_000): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > maximum) {
        throw new ConnectionActorError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new ConnectionActorError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function stringList(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > 1_000 || field.some((candidate) => typeof candidate !== "string")) {
        throw new ConnectionActorError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field.filter((candidate) => typeof candidate === "string");
}

async function body(request: Request): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, MAX_INTERNAL_BODY_LENGTH);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new ConnectionActorError("invalid_request", "The connection operation is invalid", 400);
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ConnectionActorError("invalid_request", "The connection operation is invalid", 400, {
            cause,
        });
    }
    if (!isRecord(value)) {
        throw new ConnectionActorError("invalid_request", "The connection operation must be an object", 400);
    }
    return value;
}

function operation(request: Request): string {
    const segments = new URL(request.url).pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 3 || segments[0] !== "internal" || segments[1] !== "bot-connections") {
        throw new ConnectionActorError("connection_not_found", "The connection operation does not exist", 404);
    }
    return segments[2] ?? "";
}

function rowText(row: Readonly<Record<string, SqlStorageValue>>, key: string): string {
    const value = row[key];
    if (typeof value !== "string") {
        throw new ConnectionActorError("connection_storage_unavailable", "The outbound record is invalid", 503);
    }
    return value;
}

function rowInteger(row: Readonly<Record<string, SqlStorageValue>>, key: string): number {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new ConnectionActorError("connection_storage_unavailable", "The outbound record is invalid", 503);
    }
    return value;
}

function outboundEvent(row: Readonly<Record<string, SqlStorageValue>>): object {
    const acceptedAt = new Date(rowInteger(row, "accepted_at")).toISOString();
    return {
        acceptedAt,
        behaviorRevisionId: rowText(row, "behavior_revision_id"),
        bindingId: rowText(row, "binding_id"),
        bindingRevision: rowInteger(row, "binding_revision"),
        botId: rowText(row, "bot_id"),
        conversationId: rowText(row, "conversation_id"),
        deliveryTargetId: rowText(row, "delivery_target_id"),
        eventId: `outbound:${rowText(row, "outbound_message_id")}`,
        executionId: rowText(row, "execution_id"),
        expiresAt: new Date(rowInteger(row, "expires_at")).toISOString(),
        idempotencyKey: rowText(row, "idempotency_key"),
        outboundMessageId: rowText(row, "outbound_message_id"),
        sequence: rowInteger(row, "sequence_number"),
        text: rowText(row, "text"),
        timestamp: acceptedAt,
        turnId: rowText(row, "turn_id"),
    };
}

class ClaimedDelivery {
    readonly claimDeadlineAt: number;
    readonly claimId: string;
    readonly row: Readonly<Record<string, SqlStorageValue>>;

    constructor(row: Readonly<Record<string, SqlStorageValue>>, claimId: string, claimDeadlineAt: number) {
        this.row = row;
        this.claimId = claimId;
        this.claimDeadlineAt = claimDeadlineAt;
    }

    readonly event = (): object => ({
        ...outboundEvent(this.row),
        claimDeadlineAt: new Date(this.claimDeadlineAt).toISOString(),
        claimId: this.claimId,
    });
}

export class BotConnectionActor {
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState) {
        this.#state = state;
        state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS connection_outbound_messages (
            connection_id TEXT NOT NULL,
            outbound_message_id TEXT NOT NULL,
            sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            behavior_revision_id TEXT NOT NULL,
            binding_id TEXT NOT NULL,
            binding_revision INTEGER NOT NULL,
            execution_id TEXT NOT NULL,
            delivery_target_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            text TEXT NOT NULL,
            accepted_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'retryable_failed', 'terminal_failed')),
            available_at INTEGER NOT NULL,
            claim_id TEXT,
            claim_deadline_at INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            delivered_at INTEGER,
            failed_at INTEGER,
            failure_code TEXT,
            UNIQUE(connection_id, outbound_message_id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS connection_outbound_available
            ON connection_outbound_messages(connection_id, state, available_at, sequence_number);
          CREATE TABLE IF NOT EXISTS connection_delivery_claims (
            claim_id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            outbound_message_id TEXT NOT NULL,
            claimed_at INTEGER NOT NULL,
            deadline_at INTEGER NOT NULL,
            acknowledged_at INTEGER,
            outcome TEXT
          ) STRICT;
          CREATE TABLE IF NOT EXISTS connection_delivery_cursors (
            connection_id TEXT PRIMARY KEY,
            last_issued_sequence INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
        `);
    }

    async fetch(request: Request): Promise<Response> {
        try {
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }
            const name = operation(request);
            const value = await body(request);
            if (name === "enqueue") {
                assertKeys(value, [
                    "acceptedAt",
                    "behaviorRevisionId",
                    "bindingId",
                    "bindingRevision",
                    "botId",
                    "connectionId",
                    "conversationId",
                    "deliveryTargetId",
                    "executionId",
                    "expiresAt",
                    "idempotencyKey",
                    "outboundMessageId",
                    "text",
                    "turnId",
                ]);
                const result = this.enqueue(value);
                await this.scheduleExpiry();
                return Response.json(result);
            }
            if (name === "read") {
                assertKeys(value, ["activeDeliveryTargetIds", "after", "connectionId", "limit", "now"]);
                return Response.json(
                    this.read(
                        text(value, "connectionId"),
                        integer(value, "after"),
                        integer(value, "limit"),
                        integer(value, "now"),
                        stringList(value, "activeDeliveryTargetIds"),
                    ),
                );
            }
            if (name === "delivered") {
                assertKeys(value, ["claimId", "connectionId", "now", "outboundMessageId"]);
                return Response.json(
                    this.acknowledge(
                        text(value, "connectionId"),
                        text(value, "outboundMessageId"),
                        text(value, "claimId"),
                        "delivered",
                        "",
                        integer(value, "now"),
                        integer(value, "now"),
                    ),
                );
            }
            if (name === "retryable-failure") {
                assertKeys(value, ["claimId", "code", "connectionId", "now", "outboundMessageId", "retryAt"]);
                return Response.json(
                    this.acknowledge(
                        text(value, "connectionId"),
                        text(value, "outboundMessageId"),
                        text(value, "claimId"),
                        "retryable_failed",
                        text(value, "code", 128),
                        integer(value, "now"),
                        integer(value, "retryAt"),
                    ),
                );
            }
            if (name === "terminal-failure") {
                assertKeys(value, ["claimId", "code", "connectionId", "now", "outboundMessageId"]);
                return Response.json(
                    this.acknowledge(
                        text(value, "connectionId"),
                        text(value, "outboundMessageId"),
                        text(value, "claimId"),
                        "terminal_failed",
                        text(value, "code", 128),
                        integer(value, "now"),
                        integer(value, "now"),
                    ),
                );
            }
            throw new ConnectionActorError("connection_not_found", "The connection operation does not exist", 404);
        } catch (error) {
            if (request.signal.aborted) {
                throw error;
            }
            if (error instanceof ConnectionActorError) {
                return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
            }
            console.error("Bot connection operation failed", error);
            return Response.json(
                {
                    error: {
                        code: "connection_storage_unavailable",
                        message: "The Bot connection storage is unavailable",
                    },
                },
                { status: 503 },
            );
        }
    }

    async alarm(): Promise<void> {
        this.expire(Date.now());
        await this.scheduleExpiry();
    }

    private readonly enqueue = (value: Readonly<Record<string, unknown>>): object => {
        const connectionId = text(value, "connectionId");
        const outboundMessageId = text(value, "outboundMessageId");
        const existing = this.#state.storage.sql
            .exec(
                `SELECT * FROM connection_outbound_messages
                  WHERE connection_id = ? AND outbound_message_id = ?`,
                connectionId,
                outboundMessageId,
            )
            .toArray()[0];
        if (existing !== undefined) {
            if (
                rowText(existing, "bot_id") !== text(value, "botId") ||
                rowText(existing, "conversation_id") !== text(value, "conversationId") ||
                rowText(existing, "turn_id") !== text(value, "turnId") ||
                rowText(existing, "behavior_revision_id") !== text(value, "behaviorRevisionId") ||
                rowText(existing, "binding_id") !== text(value, "bindingId") ||
                rowInteger(existing, "binding_revision") !== integer(value, "bindingRevision") ||
                rowText(existing, "execution_id") !== text(value, "executionId") ||
                rowText(existing, "delivery_target_id") !== text(value, "deliveryTargetId") ||
                rowText(existing, "idempotency_key") !== text(value, "idempotencyKey") ||
                rowText(existing, "text") !== text(value, "text")
            ) {
                throw new ConnectionActorError("idempotency_conflict", "The outbound message identity conflicts", 409);
            }
            return { duplicate: true, event: outboundEvent(existing) };
        }
        const depth = this.#state.storage.sql
            .exec(
                `SELECT COUNT(*) AS depth FROM connection_outbound_messages
                  WHERE connection_id = ? AND state IN ('queued', 'claimed', 'retryable_failed')`,
                connectionId,
            )
            .toArray()[0];
        if (depth === undefined || rowInteger(depth, "depth") >= MAX_CONNECTION_QUEUE_DEPTH) {
            throw new ConnectionActorError("queue_full", "The Bot connection queue is full", 429);
        }
        const acceptedAt = Date.parse(text(value, "acceptedAt"));
        const expiresAt = Date.parse(text(value, "expiresAt"));
        if (
            !Number.isSafeInteger(acceptedAt) ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt !== acceptedAt + OUTBOUND_MESSAGE_LIFETIME_MILLISECONDS
        ) {
            throw new ConnectionActorError("invalid_request", "The acceptedAt field is invalid", 400);
        }
        this.#state.storage.sql.exec(
            `INSERT INTO connection_outbound_messages (
               connection_id, outbound_message_id, bot_id, conversation_id,
               turn_id, behavior_revision_id, binding_id, binding_revision, execution_id,
               delivery_target_id, idempotency_key, text, accepted_at, expires_at, state, available_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
            connectionId,
            outboundMessageId,
            text(value, "botId"),
            text(value, "conversationId"),
            text(value, "turnId"),
            text(value, "behaviorRevisionId"),
            text(value, "bindingId"),
            integer(value, "bindingRevision"),
            text(value, "executionId"),
            text(value, "deliveryTargetId"),
            text(value, "idempotencyKey"),
            text(value, "text"),
            acceptedAt,
            expiresAt,
            acceptedAt,
        );
        const inserted = this.#state.storage.sql
            .exec(
                `SELECT * FROM connection_outbound_messages
                  WHERE connection_id = ? AND outbound_message_id = ?`,
                connectionId,
                outboundMessageId,
            )
            .toArray()[0];
        if (inserted === undefined) {
            throw new ConnectionActorError(
                "connection_storage_unavailable",
                "The outbound message was not queued",
                503,
            );
        }
        return { duplicate: false, event: outboundEvent(inserted) };
    };

    private readonly read = (
        connectionId: string,
        after: number,
        limit: number,
        now: number,
        activeTargetIds: readonly string[],
    ): object => {
        const boundedLimit = Math.min(Math.max(limit, 1), 100);
        const active = new Set(activeTargetIds);
        this.expire(now, connectionId);
        const candidates = this.#state.storage.sql
            .exec(
                `SELECT * FROM connection_outbound_messages
                  WHERE connection_id = ? AND expires_at > ?
                    AND (
                      (state = 'queued' AND sequence_number > ? AND available_at <= ?)
                      OR (state = 'retryable_failed' AND available_at <= ?)
                      OR (state = 'claimed' AND claim_deadline_at <= ?)
                    )
                  ORDER BY sequence_number LIMIT ?`,
                connectionId,
                now,
                after,
                now,
                now,
                now,
                boundedLimit,
            )
            .toArray();
        const claimed: ClaimedDelivery[] = [];
        this.#state.storage.transactionSync(() => {
            for (const candidate of candidates) {
                if (!active.has(rowText(candidate, "delivery_target_id"))) {
                    continue;
                }
                const claimId = `clm_${crypto.randomUUID()}`;
                const deadlineAt = now + DELIVERY_CLAIM_MILLISECONDS;
                this.#state.storage.sql.exec(
                    `UPDATE connection_outbound_messages
                        SET state = 'claimed', claim_id = ?, claim_deadline_at = ?,
                            attempt_count = attempt_count + 1
                      WHERE connection_id = ? AND outbound_message_id = ?`,
                    claimId,
                    deadlineAt,
                    connectionId,
                    rowText(candidate, "outbound_message_id"),
                );
                this.#state.storage.sql.exec(
                    `INSERT INTO connection_delivery_claims (
                       claim_id, connection_id, outbound_message_id, claimed_at, deadline_at
                     ) VALUES (?, ?, ?, ?, ?)`,
                    claimId,
                    connectionId,
                    rowText(candidate, "outbound_message_id"),
                    now,
                    deadlineAt,
                );
                claimed.push(new ClaimedDelivery(candidate, claimId, deadlineAt));
            }
            const cursor = claimed.reduce(
                (maximum, delivery) => Math.max(maximum, rowInteger(delivery.row, "sequence_number")),
                after,
            );
            this.#state.storage.sql.exec(
                `INSERT INTO connection_delivery_cursors (connection_id, last_issued_sequence, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(connection_id) DO UPDATE SET
                   last_issued_sequence = MAX(last_issued_sequence, excluded.last_issued_sequence),
                   updated_at = excluded.updated_at`,
                connectionId,
                cursor,
                now,
            );
        });
        const cursor = claimed.reduce(
            (maximum, delivery) => Math.max(maximum, rowInteger(delivery.row, "sequence_number")),
            after,
        );
        return { cursor, events: claimed.map((delivery) => delivery.event()) };
    };

    private readonly expire = (now: number, connectionId = ""): void => {
        if (connectionId.length > 0) {
            this.#state.storage.sql.exec(
                `UPDATE connection_outbound_messages
                    SET state = 'terminal_failed', failed_at = ?, failure_code = 'delivery_expired'
                  WHERE connection_id = ? AND expires_at <= ?
                    AND state IN ('queued', 'claimed', 'retryable_failed')`,
                now,
                connectionId,
                now,
            );
            return;
        }
        this.#state.storage.sql.exec(
            `UPDATE connection_outbound_messages
                SET state = 'terminal_failed', failed_at = ?, failure_code = 'delivery_expired'
              WHERE expires_at <= ? AND state IN ('queued', 'claimed', 'retryable_failed')`,
            now,
            now,
        );
    };

    private readonly scheduleExpiry = async (): Promise<void> => {
        const row = this.#state.storage.sql
            .exec(
                `SELECT MIN(expires_at) AS next_expiry
                   FROM connection_outbound_messages
                  WHERE state IN ('queued', 'claimed', 'retryable_failed')`,
            )
            .toArray()[0];
        if (row === undefined || row["next_expiry"] === null) {
            return;
        }
        const nextExpiry = rowInteger(row, "next_expiry");
        await this.#state.storage.setAlarm(Math.max(Date.now() + 1, nextExpiry));
    };

    private readonly acknowledge = (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        state: string,
        code: string,
        now: number,
        availableAt: number,
    ): object => {
        const claim = this.#state.storage.sql
            .exec(
                `SELECT * FROM connection_delivery_claims
                  WHERE claim_id = ? AND connection_id = ? AND outbound_message_id = ?`,
                claimId,
                connectionId,
                outboundMessageId,
            )
            .toArray()[0];
        if (claim === undefined) {
            throw new ConnectionActorError("revision_conflict", "The outbound delivery claim is invalid", 409);
        }
        if (claim["acknowledged_at"] !== null) {
            const priorOutcome = rowText(claim, "outcome");
            if (priorOutcome === state) {
                return { duplicate: true, outboundMessageId, state };
            }
            throw new ConnectionActorError("revision_conflict", "The outbound delivery claim already settled", 409);
        }
        if (rowInteger(claim, "deadline_at") <= now) {
            throw new ConnectionActorError("revision_conflict", "The outbound delivery claim has expired", 409);
        }
        const row = this.#state.storage.sql
            .exec(
                `SELECT * FROM connection_outbound_messages
                  WHERE connection_id = ? AND outbound_message_id = ?`,
                connectionId,
                outboundMessageId,
            )
            .toArray()[0];
        if (row === undefined) {
            throw new ConnectionActorError("connection_not_found", "The outbound message does not exist", 404);
        }
        const currentState = rowText(row, "state");
        if (currentState !== "claimed" || rowText(row, "claim_id") !== claimId) {
            throw new ConnectionActorError("revision_conflict", "The outbound delivery claim is no longer active", 409);
        }
        this.#state.storage.transactionSync(() => {
            if (state === "retryable_failed") {
                this.#state.storage.sql.exec(
                    `UPDATE connection_outbound_messages
                        SET state = ?, available_at = ?, failed_at = ?, failure_code = ?,
                            claim_id = NULL, claim_deadline_at = NULL
                      WHERE connection_id = ? AND outbound_message_id = ?
                        AND state = 'claimed' AND claim_id = ?`,
                    state,
                    availableAt,
                    now,
                    code,
                    connectionId,
                    outboundMessageId,
                    claimId,
                );
            } else {
                this.#state.storage.sql.exec(
                    `UPDATE connection_outbound_messages
                        SET state = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                            failed_at = CASE WHEN ? = 'terminal_failed' THEN ? ELSE failed_at END,
                            failure_code = CASE WHEN ? = 'terminal_failed' THEN ? ELSE failure_code END
                      WHERE connection_id = ? AND outbound_message_id = ?
                        AND state = 'claimed' AND claim_id = ?`,
                    state,
                    state,
                    now,
                    state,
                    now,
                    state,
                    code,
                    connectionId,
                    outboundMessageId,
                    claimId,
                );
            }
            this.#state.storage.sql.exec(
                `UPDATE connection_delivery_claims
                    SET acknowledged_at = ?, outcome = ?
                  WHERE claim_id = ? AND acknowledged_at IS NULL`,
                now,
                state,
                claimId,
            );
        });
        return { duplicate: false, outboundMessageId, state };
    };
}
