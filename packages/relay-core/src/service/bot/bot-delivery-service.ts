import { BotDeliveryError } from "../../entity/bot/bot-delivery-error.ts";
import type { DoSqlRow } from "../../infra/do-sql-database.ts";
import type { BotDeliveryStorage } from "../../storage/bot-delivery-storage.ts";

export interface OutboundDelivery {
    readonly connectionId: string;
    readonly outboundMessageId: string;
    readonly botId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly executionId: string;
    readonly deliveryTargetId: string;
    readonly idempotencyKey: string;
    readonly text: string;
    readonly acceptedAt: string;
    readonly expiresAt: string;
}

function text(row: DoSqlRow, key: string): string {
    const value = row[key];
    if (typeof value !== "string") {
        throw new BotDeliveryError("connection_storage_unavailable", "The outbound record is invalid");
    }
    return value;
}
function integer(row: DoSqlRow, key: string): number {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new BotDeliveryError("connection_storage_unavailable", "The outbound record is invalid");
    }
    return value;
}
function event(row: DoSqlRow) {
    const acceptedAt = new Date(integer(row, "accepted_at")).toISOString();
    return {
        acceptedAt,
        behaviorRevisionId: text(row, "behavior_revision_id"),
        bindingId: text(row, "binding_id"),
        bindingRevision: integer(row, "binding_revision"),
        botId: text(row, "bot_id"),
        conversationId: text(row, "conversation_id"),
        deliveryTargetId: text(row, "delivery_target_id"),
        eventId: `outbound:${text(row, "outbound_message_id")}`,
        executionId: text(row, "execution_id"),
        expiresAt: new Date(integer(row, "expires_at")).toISOString(),
        idempotencyKey: text(row, "idempotency_key"),
        outboundMessageId: text(row, "outbound_message_id"),
        sequence: integer(row, "sequence_number"),
        text: text(row, "text"),
        timestamp: acceptedAt,
        turnId: text(row, "turn_id"),
    };
}

export class BotDeliveryService {
    readonly #storage: BotDeliveryStorage;
    readonly #schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
    constructor(storage: BotDeliveryStorage, schedule: (timestamp: number, signal: AbortSignal) => Promise<void>) {
        this.#storage = storage;
        this.#schedule = schedule;
    }

    readonly enqueue = async (value: OutboundDelivery, signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = this.queue(value);
        await this.scheduleExpiry(signal);
        return result;
    };

    private readonly queue = (value: OutboundDelivery) => {
        const existing = this.#storage.readMessage(value.connectionId, value.outboundMessageId);
        if (existing !== undefined) {
            if (
                text(existing, "bot_id") !== value.botId ||
                text(existing, "conversation_id") !== value.conversationId ||
                text(existing, "turn_id") !== value.turnId ||
                text(existing, "behavior_revision_id") !== value.behaviorRevisionId ||
                text(existing, "binding_id") !== value.bindingId ||
                integer(existing, "binding_revision") !== value.bindingRevision ||
                text(existing, "execution_id") !== value.executionId ||
                text(existing, "delivery_target_id") !== value.deliveryTargetId ||
                text(existing, "idempotency_key") !== value.idempotencyKey ||
                text(existing, "text") !== value.text
            ) {
                throw new BotDeliveryError("idempotency_conflict", "The outbound message identity conflicts");
            }
            return { duplicate: true, event: event(existing) };
        }
        const depth = this.#storage.readDepth(value.connectionId);
        if (depth === undefined || integer(depth, "depth") >= 10_000) {
            throw new BotDeliveryError("queue_full", "The Bot connection queue is full");
        }
        const acceptedAt = Date.parse(value.acceptedAt);
        const expiresAt = Date.parse(value.expiresAt);
        if (
            !Number.isSafeInteger(acceptedAt) ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt !== acceptedAt + 7 * 24 * 60 * 60 * 1_000
        ) {
            throw new BotDeliveryError("invalid_request", "The acceptedAt field is invalid");
        }
        this.#storage.insertMessage({ ...value, acceptedAt, expiresAt });
        const inserted = this.#storage.readMessage(value.connectionId, value.outboundMessageId);
        if (inserted === undefined) {
            throw new BotDeliveryError("connection_storage_unavailable", "The outbound message was not queued");
        }
        return { duplicate: false, event: event(inserted) };
    };

    readonly read = (
        connectionId: string,
        after: number,
        limit: number,
        now: number,
        activeTargetIds: readonly string[],
    ) => {
        const boundedLimit = Math.min(Math.max(limit, 1), 100);
        const active = new Set(activeTargetIds);
        this.#storage.expire(now, connectionId);
        const candidates = this.#storage.listCandidates(connectionId, after, boundedLimit, now);
        const events = [];
        let cursor = after;
        const deadline = now + 60_000;
        for (const candidate of candidates) {
            if (!active.has(text(candidate, "delivery_target_id"))) {
                continue;
            }
            const claimId = `clm_${crypto.randomUUID()}`;
            cursor = Math.max(cursor, integer(candidate, "sequence_number"));
            events.push({ ...event(candidate), claimId, claimDeadlineAt: new Date(deadline).toISOString() });
        }
        this.#storage.writeClaims({
            connectionId,
            cursor,
            claimedAt: now,
            deadlineAt: deadline,
            claims: events.map((value) => ({ outboundMessageId: value.outboundMessageId, claimId: value.claimId })),
        });
        return { cursor, events };
    };

    readonly recover = async (now: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        this.#storage.expire(now, "");
        await this.scheduleExpiry(signal);
    };

    private readonly scheduleExpiry = async (signal: AbortSignal): Promise<void> => {
        const next = this.nextAlarm(Date.now());
        if (next !== null) {
            await this.#schedule(next, signal);
        }
    };

    private readonly nextAlarm = (now: number): number | null => {
        const row = this.#storage.nextExpiry();
        return row === undefined || row["next_expiry"] === null ? null : Math.max(now + 1, integer(row, "next_expiry"));
    };

    readonly acknowledge = (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        state: "delivered" | "retryable_failed" | "terminal_failed",
        code: string,
        now: number,
        availableAt: number,
    ) => {
        const claim = this.#storage.readClaim(connectionId, outboundMessageId, claimId);
        if (claim === undefined) {
            throw new BotDeliveryError("revision_conflict", "The outbound delivery claim is invalid");
        }
        if (claim["acknowledged_at"] !== null) {
            if (text(claim, "outcome") === state) {
                return { duplicate: true, outboundMessageId, state };
            }
            throw new BotDeliveryError("revision_conflict", "The outbound delivery claim already settled");
        }
        if (integer(claim, "deadline_at") <= now) {
            throw new BotDeliveryError("revision_conflict", "The outbound delivery claim has expired");
        }
        const row = this.#storage.readMessage(connectionId, outboundMessageId);
        if (row === undefined) {
            throw new BotDeliveryError("connection_not_found", "The outbound message does not exist");
        }
        if (text(row, "state") !== "claimed" || text(row, "claim_id") !== claimId) {
            throw new BotDeliveryError("revision_conflict", "The outbound delivery claim is no longer active");
        }
        this.#storage.acknowledge(connectionId, outboundMessageId, claimId, state, code, now, availableAt);
        return { duplicate: false, outboundMessageId, state };
    };
}
