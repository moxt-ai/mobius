import type { BotSessionProvisioning } from "../../entity/bot/bot-session.ts";
import type { DoSqlDatabase, DoSqlRow } from "../../infra/do-sql-database.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import { initializeBotSessionSchema } from "./sqlite-bot-schema.ts";

export class BotSessionStorage {
    readonly #database: DoSqlDatabase;
    constructor(database: DoSqlDatabase) {
        this.#database = database;
        initializeBotSessionSchema(database);
    }

    readonly insertOutboundWithUsage = (
        input: Parameters<BotSessionStorage["insertOutbound"]>[0],
    ):
        | { readonly kind: "existing"; readonly receipt: DoSqlRow }
        | { readonly kind: "limit-reached" }
        | { readonly kind: "inserted"; readonly receipt: DoSqlRow }
        | { readonly kind: "unavailable" } =>
        this.#database.transaction(() => {
            const duplicate = this.readOutboundReceipt(input)[0];
            if (duplicate !== undefined) {
                return { kind: "existing", receipt: duplicate };
            }
            const capability = this.readOutboundCapability(input)[0];
            if (capability === undefined) {
                return { kind: "unavailable" };
            }
            const usageCount = capability["usage_count"];
            const usageLimit = capability["usage_limit"];
            if (
                typeof usageCount !== "number" ||
                !Number.isSafeInteger(usageCount) ||
                usageCount < 0 ||
                typeof usageLimit !== "number" ||
                !Number.isSafeInteger(usageLimit) ||
                usageLimit < 0
            ) {
                return { kind: "unavailable" };
            }
            if (usageCount >= usageLimit) {
                return { kind: "limit-reached" };
            }
            this.insertOutbound(input);
            this.incrementUsage(input);
            const accepted = this.readOutbound(input)[0];
            if (accepted === undefined) {
                throw new DatabaseError("database_unavailable", "The outbound message was not committed");
            }
            return { kind: "inserted", receipt: accepted };
        });

    readonly insertTurnExecution = (input: {
        readonly turn: Parameters<BotSessionStorage["insertTurn"]>[0];
        readonly receipt: Parameters<BotSessionStorage["insertReceipt"]>[0];
        readonly dispatch: Parameters<BotSessionStorage["insertPendingDispatch"]>[0];
        readonly execution: Parameters<BotSessionStorage["insertExecution"]>[0];
        readonly capability: Parameters<BotSessionStorage["insertCapability"]>[0];
    }):
        | { readonly kind: "existing"; readonly receipt: DoSqlRow }
        | { readonly kind: "busy" }
        | { readonly kind: "inserted" } =>
        this.#database.transaction(() => {
            const duplicate = this.readTurnReceipt(input.receipt)[0];
            if (duplicate !== undefined) {
                return { kind: "existing", receipt: duplicate };
            }
            if (this.readActiveTurn(input.turn)[0] !== undefined) {
                return { kind: "busy" };
            }
            this.insertTurn(input.turn);
            this.insertReceipt(input.receipt);
            this.insertPendingDispatch(input.dispatch);
            this.insertExecution(input.execution);
            this.insertCapability(input.capability);
            this.touchSession(input.turn);
            return { kind: "inserted" };
        });

    readonly completeExecution = (input: {
        readonly state: "completed" | "cancelled" | "failed";
        readonly completedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
        readonly completion: {
            readonly outboundMessageId: string;
            readonly botId: string;
            readonly deliveryTargetId: string;
            readonly idempotencyKey: string;
            readonly requestDigest: string;
            readonly text: string;
            readonly expiresAt: number;
        } | null;
    }): void => {
        this.#database.transaction(() => {
            if (this.settleExecution(input).changes !== 1) {
                return;
            }
            this.revokeCapability({ ...input, revokedAt: input.completedAt });
            if (input.completion !== null) {
                this.insertCompletionOutbound({
                    ...input.completion,
                    scopeKey: input.scopeKey,
                    sessionId: input.sessionId,
                    executionId: input.executionId,
                    acceptedAt: input.completedAt,
                });
            }
        });
    };

    readonly readCapability = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
    }) =>
        this.#database.query(
            `SELECT e.*, c.capability_id, c.secret_digest, c.operation,
                    c.allowed_delivery_target_ids_json, c.usage_limit,
                    c.usage_count, c.expires_at, c.revoked_at
               FROM bot_executions AS e
               INNER JOIN bot_execution_capabilities AS c
                 ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                AND c.execution_id = e.execution_id
              WHERE e.scope_key = ? AND e.session_id = ? AND e.execution_id = ?`,
            [input.scopeKey, input.sessionId, input.executionId],
        );

    readonly readContext = (input: { readonly scopeKey: string; readonly sessionId: string }) =>
        this.#database.query(`SELECT * FROM bot_session_context WHERE scope_key = ? AND session_id = ?`, [
            input.scopeKey,
            input.sessionId,
        ]);

    readonly insertContext = (input: {
        readonly scopeKey: string;
        readonly provisioning: BotSessionProvisioning;
        readonly createdAt: number;
    }) =>
        this.#database.run(
            `INSERT INTO bot_session_context (
               scope_key, session_id, conversation_id, bot_id,
               behavior_revision_id, binding_id, binding_revision,
               runtime_id, agent_ref, workspace_ref, agent_config_revision,
               local_grant_id, creator_kind, creator_principal_id,
               behavior_instructions, behavior_digest,
               allowed_delivery_targets_json, completion_policy_json,
               reply_route_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                input.scopeKey,
                input.provisioning.sessionId,
                input.provisioning.conversationId,
                input.provisioning.botId,
                input.provisioning.behaviorRevisionId,
                input.provisioning.bindingId,
                input.provisioning.bindingRevision,
                input.provisioning.runtimeId,
                input.provisioning.agentRef,
                input.provisioning.workspaceRef,
                input.provisioning.agentConfigRevision,
                input.provisioning.localGrantId,
                input.provisioning.creatorKind,
                input.provisioning.creatorPrincipalId,
                input.provisioning.behaviorInstructions,
                input.provisioning.behaviorDigest,
                JSON.stringify(input.provisioning.allowedDeliveryTargets),
                JSON.stringify(input.provisioning.completionPolicy),
                JSON.stringify(input.provisioning.replyRoute),
                input.createdAt,
            ],
        );

    private readonly readTurnReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandKind: string;
        readonly idempotencyKey: string;
    }) =>
        this.#database.query(
            `SELECT e.*, c.capability_id, t.request_hash
                   FROM command_receipts r
                   INNER JOIN turns t
                     ON t.scope_key = r.scope_key AND t.session_id = r.session_id
                    AND t.turn_id = r.result_id
                   INNER JOIN bot_executions e
                     ON e.scope_key = t.scope_key AND e.session_id = t.session_id
                    AND e.turn_id = t.turn_id
                   INNER JOIN bot_execution_capabilities c
                     ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                    AND c.execution_id = e.execution_id
                  WHERE r.scope_key = ? AND r.session_id = ?
                    AND r.command_kind = ? AND r.idempotency_key = ?`,
            [input.scopeKey, input.sessionId, input.commandKind, input.idempotencyKey],
        );

    private readonly readActiveTurn = (input: { readonly scopeKey: string; readonly sessionId: string }) =>
        this.#database.query(
            `SELECT 1 AS active FROM turns
                  WHERE scope_key = ? AND session_id = ?
                    AND state IN ('queued', 'running', 'indeterminate') LIMIT 1`,
            [input.scopeKey, input.sessionId],
        );

    private readonly insertTurn = (input: {
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
    }) =>
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

    private readonly insertReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandKind: string;
        readonly idempotencyKey: string;
        readonly requestHash: string;
        readonly resultId: string;
        readonly acceptedAt: number;
    }) =>
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

    private readonly insertPendingDispatch = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly workId: string;
        readonly runtimeId: string;
        readonly deliveryPayload: string;
        readonly queuedAt: number;
    }) =>
        this.#database.run(
            `INSERT INTO pending_work (
                   scope_key, session_id, work_id, work_kind, runtime_id,
                   delivery_payload, state, queued_at
                 ) VALUES (?, ?, ?, 'dispatch', ?, ?, 'pending', ?)`,
            [input.scopeKey, input.sessionId, input.workId, input.runtimeId, input.deliveryPayload, input.queuedAt],
        );

    private readonly insertExecution = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
        readonly botId: string;
        readonly conversationId: string;
        readonly turnId: string;
        readonly commandId: string;
        readonly behaviorRevisionId: string;
        readonly bindingId: string;
        readonly bindingRevision: number;
        readonly runtimeId: string;
        readonly createdAt: number;
        readonly deadlineAt: number;
    }) =>
        this.#database.run(
            `INSERT INTO bot_executions (
                   scope_key, session_id, execution_id, bot_id, conversation_id,
                   turn_id, command_id, behavior_revision_id, binding_id,
                   binding_revision, runtime_id, state, created_at, deadline_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.executionId,
                input.botId,
                input.conversationId,
                input.turnId,
                input.commandId,
                input.behaviorRevisionId,
                input.bindingId,
                input.bindingRevision,
                input.runtimeId,
                input.createdAt,
                input.deadlineAt,
            ],
        );

    private readonly insertCapability = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly capabilityId: string;
        readonly executionId: string;
        readonly secretDigest: string;
        readonly allowedDeliveryTargetIds: readonly string[];
        readonly usageLimit: number;
        readonly expiresAt: number;
    }) =>
        this.#database.run(
            `INSERT INTO bot_execution_capabilities (
                   scope_key, session_id, capability_id, execution_id,
                   secret_digest, operation, allowed_delivery_target_ids_json,
                   usage_limit, expires_at
                 ) VALUES (?, ?, ?, ?, ?, 'outbound-message:create', ?, ?, ?)`,
            [
                input.scopeKey,
                input.sessionId,
                input.capabilityId,
                input.executionId,
                input.secretDigest,
                JSON.stringify(input.allowedDeliveryTargetIds),
                input.usageLimit,
                input.expiresAt,
            ],
        );

    private readonly touchSession = (input: {
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }) =>
        this.#database.run(`UPDATE sessions SET updated_at = ? WHERE scope_key = ? AND session_id = ?`, [
            input.updatedAt,
            input.scopeKey,
            input.sessionId,
        ]);

    readonly readOutboundCapability = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
    }) =>
        this.#database.query(
            `SELECT e.*, c.capability_id, c.secret_digest, c.allowed_delivery_target_ids_json,
                        c.usage_limit, c.usage_count, c.expires_at, c.revoked_at
                   FROM bot_executions e
                   INNER JOIN bot_execution_capabilities c
                     ON c.scope_key = e.scope_key AND c.session_id = e.session_id
                    AND c.execution_id = e.execution_id
                  WHERE e.scope_key = ? AND e.session_id = ? AND e.execution_id = ?`,
            [input.scopeKey, input.sessionId, input.executionId],
        );

    private readonly readOutboundReceipt = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
        readonly idempotencyKey: string;
    }) =>
        this.#database.query(
            `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.execution_id = ? AND requests.idempotency_key = ?`,
            [input.scopeKey, input.sessionId, input.executionId, input.idempotencyKey],
        );

    private readonly insertOutbound = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly outboundMessageId: string;
        readonly executionId: string;
        readonly botId: string;
        readonly deliveryTargetId: string;
        readonly idempotencyKey: string;
        readonly requestDigest: string;
        readonly text: string;
        readonly acceptedAt: number;
        readonly expiresAt: number;
    }) =>
        this.#database.run(
            `INSERT INTO bot_outbound_requests (
                   scope_key, session_id, outbound_message_id, execution_id,
                   bot_id, delivery_target_id, idempotency_key, request_digest,
                   text, accepted_at, expires_at, state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
            [
                input.scopeKey,
                input.sessionId,
                input.outboundMessageId,
                input.executionId,
                input.botId,
                input.deliveryTargetId,
                input.idempotencyKey,
                input.requestDigest,
                input.text,
                input.acceptedAt,
                input.expiresAt,
            ],
        );

    private readonly incrementUsage = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
    }) =>
        this.#database.run(
            `UPDATE bot_execution_capabilities
                    SET usage_count = usage_count + 1
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ?`,
            [input.scopeKey, input.sessionId, input.executionId],
        );

    private readonly readOutbound = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly outboundMessageId: string;
    }) =>
        this.#database.query(
            `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.outbound_message_id = ?`,
            [input.scopeKey, input.sessionId, input.outboundMessageId],
        );

    readonly expireOutbound = (input: {
        readonly failedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly expiresAt: number;
    }) =>
        this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'terminal_failed', failed_at = ?, failure_code = 'delivery_expired'
              WHERE scope_key = ? AND session_id = ? AND state = 'accepted' AND expires_at <= ?`,
            [input.failedAt, input.scopeKey, input.sessionId, input.expiresAt],
        );

    readonly listPendingOutbound = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly limit: number;
    }) =>
        this.#database.query(
            `SELECT requests.*, executions.conversation_id, executions.turn_id,
                        executions.behavior_revision_id, executions.binding_id,
                        executions.binding_revision
                   FROM bot_outbound_requests AS requests
                   INNER JOIN bot_executions AS executions
                     ON executions.scope_key = requests.scope_key
                    AND executions.session_id = requests.session_id
                    AND executions.execution_id = requests.execution_id
                  WHERE requests.scope_key = ? AND requests.session_id = ?
                    AND requests.state = 'accepted'
                  ORDER BY requests.accepted_at, requests.outbound_message_id LIMIT ?`,
            [input.scopeKey, input.sessionId, input.limit],
        );

    readonly markForwarded = (input: {
        readonly forwardedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly outboundMessageId: string;
    }) =>
        this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'forwarded', forwarded_at = COALESCE(forwarded_at, ?)
              WHERE scope_key = ? AND session_id = ? AND outbound_message_id = ?`,
            [input.forwardedAt, input.scopeKey, input.sessionId, input.outboundMessageId],
        );

    readonly markTerminalFailure = (input: {
        readonly failedAt: number;
        readonly failureCode: string;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly outboundMessageId: string;
    }) =>
        this.#database.run(
            `UPDATE bot_outbound_requests
                SET state = 'terminal_failed', failed_at = COALESCE(failed_at, ?),
                    failure_code = COALESCE(failure_code, ?)
              WHERE scope_key = ? AND session_id = ? AND outbound_message_id = ?
                AND state IN ('accepted', 'terminal_failed')`,
            [input.failedAt, input.failureCode, input.scopeKey, input.sessionId, input.outboundMessageId],
        );

    readonly readCommandExecution = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }) =>
        this.#database.query(
            `SELECT * FROM bot_executions
                  WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [input.scopeKey, input.sessionId, input.commandId],
        );

    private readonly settleExecution = (input: {
        readonly state: "completed" | "cancelled" | "failed";
        readonly completedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
    }) =>
        this.#database.run(
            `UPDATE bot_executions SET state = ?, completed_at = ?
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ? AND state = 'active'`,
            [input.state, input.completedAt, input.scopeKey, input.sessionId, input.executionId],
        );

    private readonly revokeCapability = (input: {
        readonly revokedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly executionId: string;
    }) =>
        this.#database.run(
            `UPDATE bot_execution_capabilities SET revoked_at = COALESCE(revoked_at, ?)
                  WHERE scope_key = ? AND session_id = ? AND execution_id = ?`,
            [input.revokedAt, input.scopeKey, input.sessionId, input.executionId],
        );

    private readonly insertCompletionOutbound = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly outboundMessageId: string;
        readonly executionId: string;
        readonly botId: string;
        readonly deliveryTargetId: string;
        readonly idempotencyKey: string;
        readonly requestDigest: string;
        readonly text: string;
        readonly acceptedAt: number;
        readonly expiresAt: number;
    }) =>
        this.#database.run(
            `INSERT OR IGNORE INTO bot_outbound_requests (
                   scope_key, session_id, outbound_message_id, execution_id,
                   bot_id, delivery_target_id, idempotency_key, request_digest,
                   text, accepted_at, expires_at, state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`,
            [
                input.scopeKey,
                input.sessionId,
                input.outboundMessageId,
                input.executionId,
                input.botId,
                input.deliveryTargetId,
                input.idempotencyKey,
                input.requestDigest,
                input.text,
                input.acceptedAt,
                input.expiresAt,
            ],
        );

    readonly readAttemptTurn = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly attemptId: string;
    }) =>
        this.#database.query(
            `SELECT turn_id FROM attempts
                  WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
            [input.scopeKey, input.sessionId, input.attemptId],
        );

    readonly readCommandTurn = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }) =>
        this.#database.query(
            `SELECT turn_id FROM turns
              WHERE scope_key = ? AND session_id = ? AND command_id = ?`,
            [input.scopeKey, input.sessionId, input.commandId],
        );
}
