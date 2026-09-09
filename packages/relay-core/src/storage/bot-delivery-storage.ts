import type { DoSqlDatabase, DoSqlRow } from "../infra/do-sql-database.ts";

export class BotDeliveryStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
        database.exec(`
          CREATE TABLE IF NOT EXISTS connection_outbound_messages (
            connection_id TEXT NOT NULL, outbound_message_id TEXT NOT NULL,
            sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
            behavior_revision_id TEXT NOT NULL, binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
            execution_id TEXT NOT NULL, delivery_target_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            text TEXT NOT NULL, accepted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'delivered', 'retryable_failed', 'terminal_failed')),
            available_at INTEGER NOT NULL, claim_id TEXT, claim_deadline_at INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER, failed_at INTEGER, failure_code TEXT,
            UNIQUE(connection_id, outbound_message_id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS connection_outbound_available
            ON connection_outbound_messages(connection_id, state, available_at, sequence_number);
          CREATE TABLE IF NOT EXISTS connection_delivery_claims (
            claim_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, outbound_message_id TEXT NOT NULL,
            claimed_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, acknowledged_at INTEGER, outcome TEXT
          ) STRICT;
          CREATE TABLE IF NOT EXISTS connection_delivery_cursors (
            connection_id TEXT PRIMARY KEY, last_issued_sequence INTEGER NOT NULL, updated_at INTEGER NOT NULL
          ) STRICT;
        `);
    }

    readonly writeClaims = (input: {
        readonly connectionId: string;
        readonly cursor: number;
        readonly claimedAt: number;
        readonly deadlineAt: number;
        readonly claims: readonly { readonly outboundMessageId: string; readonly claimId: string }[];
    }): void => {
        this.#database.transaction(() => {
            for (const claim of input.claims) {
                this.claim(
                    input.connectionId,
                    claim.outboundMessageId,
                    claim.claimId,
                    input.claimedAt,
                    input.deadlineAt,
                );
            }
            this.updateCursor(input.connectionId, input.cursor, input.claimedAt);
        });
    };

    readonly readMessage = (connectionId: string, messageId: string): DoSqlRow | undefined =>
        this.#database.query(
            `SELECT * FROM connection_outbound_messages
            WHERE connection_id = ? AND outbound_message_id = ?`,
            [connectionId, messageId],
        )[0];

    readonly readDepth = (connectionId: string) =>
        this.#database.query(
            `SELECT COUNT(*) AS depth
        FROM connection_outbound_messages WHERE connection_id = ? AND state IN ('queued', 'claimed', 'retryable_failed')`,
            [connectionId],
        )[0];

    readonly insertMessage = (input: {
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
        readonly acceptedAt: number;
        readonly expiresAt: number;
    }): void => {
        this.#database.run(
            `INSERT INTO connection_outbound_messages (
            connection_id, outbound_message_id, bot_id, conversation_id, turn_id, behavior_revision_id,
            binding_id, binding_revision, execution_id, delivery_target_id, idempotency_key, text,
            accepted_at, expires_at, state, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
            [
                input.connectionId,
                input.outboundMessageId,
                input.botId,
                input.conversationId,
                input.turnId,
                input.behaviorRevisionId,
                input.bindingId,
                input.bindingRevision,
                input.executionId,
                input.deliveryTargetId,
                input.idempotencyKey,
                input.text,
                input.acceptedAt,
                input.expiresAt,
                input.acceptedAt,
            ],
        );
    };

    readonly listCandidates = (connectionId: string, after: number, limit: number, now: number) =>
        this.#database.query(
            `
        SELECT * FROM connection_outbound_messages WHERE connection_id = ? AND expires_at > ? AND (
            (state = 'queued' AND sequence_number > ? AND available_at <= ?)
            OR (state = 'retryable_failed' AND available_at <= ?)
            OR (state = 'claimed' AND claim_deadline_at <= ?)
        ) ORDER BY sequence_number LIMIT ?`,
            [connectionId, now, after, now, now, now, limit],
        );

    readonly claim = (
        connectionId: string,
        messageId: string,
        claimId: string,
        now: number,
        deadline: number,
    ): void => {
        this.#database.run(
            `UPDATE connection_outbound_messages SET state = 'claimed', claim_id = ?,
            claim_deadline_at = ?, attempt_count = attempt_count + 1 WHERE connection_id = ? AND outbound_message_id = ?`,
            [claimId, deadline, connectionId, messageId],
        );
        this.#database.run(
            `INSERT INTO connection_delivery_claims (
            claim_id, connection_id, outbound_message_id, claimed_at, deadline_at
        ) VALUES (?, ?, ?, ?, ?)`,
            [claimId, connectionId, messageId, now, deadline],
        );
    };

    readonly updateCursor = (connectionId: string, cursor: number, now: number): void => {
        this.#database.run(
            `INSERT INTO connection_delivery_cursors (connection_id, last_issued_sequence, updated_at)
            VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET
            last_issued_sequence = MAX(last_issued_sequence, excluded.last_issued_sequence), updated_at = excluded.updated_at`,
            [connectionId, cursor, now],
        );
    };

    readonly expire = (now: number, connectionId: string): void => {
        if (connectionId.length > 0) {
            this.#database.run(
                `UPDATE connection_outbound_messages SET state = 'terminal_failed', failed_at = ?,
                failure_code = 'delivery_expired' WHERE connection_id = ? AND expires_at <= ?
                AND state IN ('queued', 'claimed', 'retryable_failed')`,
                [now, connectionId, now],
            );
            return;
        }
        this.#database.run(
            `UPDATE connection_outbound_messages SET state = 'terminal_failed', failed_at = ?,
            failure_code = 'delivery_expired' WHERE expires_at <= ? AND state IN ('queued', 'claimed', 'retryable_failed')`,
            [now, now],
        );
    };

    readonly nextExpiry = () =>
        this.#database.query(`SELECT MIN(expires_at) AS next_expiry
        FROM connection_outbound_messages WHERE state IN ('queued', 'claimed', 'retryable_failed')`)[0];

    readonly readClaim = (connectionId: string, messageId: string, claimId: string) =>
        this.#database.query(
            `
        SELECT * FROM connection_delivery_claims WHERE claim_id = ? AND connection_id = ? AND outbound_message_id = ?`,
            [claimId, connectionId, messageId],
        )[0];

    readonly acknowledge = (
        connectionId: string,
        messageId: string,
        claimId: string,
        state: string,
        code: string,
        now: number,
        availableAt: number,
    ): void => {
        this.#database.transaction(() => {
            if (state === "retryable_failed") {
                this.#database.run(
                    `UPDATE connection_outbound_messages SET state = ?, available_at = ?, failed_at = ?,
                    failure_code = ?, claim_id = NULL, claim_deadline_at = NULL WHERE connection_id = ? AND outbound_message_id = ?
                    AND state = 'claimed' AND claim_id = ?`,
                    [state, availableAt, now, code, connectionId, messageId, claimId],
                );
            } else {
                this.#database.run(
                    `UPDATE connection_outbound_messages SET state = ?,
                    delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                    failed_at = CASE WHEN ? = 'terminal_failed' THEN ? ELSE failed_at END,
                    failure_code = CASE WHEN ? = 'terminal_failed' THEN ? ELSE failure_code END
                    WHERE connection_id = ? AND outbound_message_id = ? AND state = 'claimed' AND claim_id = ?`,
                    [state, state, now, state, now, state, code, connectionId, messageId, claimId],
                );
            }
            this.#database.run(
                `UPDATE connection_delivery_claims SET acknowledged_at = ?, outcome = ?
                WHERE claim_id = ? AND acknowledged_at IS NULL`,
                [now, state, claimId],
            );
        });
    };
}
