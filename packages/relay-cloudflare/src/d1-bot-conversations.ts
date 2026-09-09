import { BotConnectionReplyRoute, type BotReplyRoute, OwnerBotReplyRoute } from "@moxt-ai/mobius-protocol";
import {
    type BotExecutionRecord,
    type BotOutboundAcceptance,
    BotSessionProvisioning,
    BotSessionRuntimeError,
    createRandomToken,
    decodeBotSessionProvisioning,
    encodeBotSessionProvisioning,
    type ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";

import { BotApiError } from "./bot-api-error.ts";
import {
    InboundBotConnectorPrincipal,
    type InboundBotOwnerPrincipal,
    type InboundBotPrincipal,
} from "./d1-bot-auth.ts";
import type { ApprovedBindingContext } from "./d1-bot-control.ts";

interface ConversationRow {
    readonly activated_at: unknown;
    readonly behavior_revision_id: string;
    readonly binding_id: string;
    readonly binding_revision: number;
    readonly bot_id: string;
    readonly client_conversation_key: string;
    readonly connection_id: unknown;
    readonly conversation_id: string;
    readonly created_at: number;
    readonly creator_kind: string;
    readonly creator_key: string;
    readonly creator_principal_id: string;
    readonly lifecycle: string;
    readonly reply_delivery_target_id: unknown;
    readonly session_id: string;
    readonly title: string;
}

interface ProvisioningOutboxRow extends ConversationRow {
    readonly outbox_bot_id: string;
    readonly outbox_runtime_id: string;
    readonly outbox_state: string;
    readonly outbox_subject_id: string;
    readonly payload: string;
}

export class BotConversationPlan {
    readonly provisioning: BotSessionProvisioning;
    readonly response: object;

    constructor(provisioning: BotSessionProvisioning, response: object) {
        this.provisioning = provisioning;
        this.response = response;
    }
}

export class AuthorizedBotConversation {
    readonly botId: string;
    readonly connectionId: string;
    readonly conversationId: string;
    readonly creatorKind: string;
    readonly sessionId: string;

    constructor(row: ConversationRow) {
        this.botId = row.bot_id;
        this.conversationId = row.conversation_id;
        this.sessionId = row.session_id;
        this.creatorKind = row.creator_kind;
        this.connectionId = typeof row.connection_id === "string" ? row.connection_id : "";
    }
}

function replyRouteFromRow(row: ConversationRow): BotReplyRoute {
    if (
        row.creator_kind === "connection" &&
        typeof row.connection_id === "string" &&
        typeof row.reply_delivery_target_id === "string"
    ) {
        return new BotConnectionReplyRoute(row.connection_id, row.reply_delivery_target_id);
    }
    if (row.creator_kind === "owner" && row.connection_id === null && row.reply_delivery_target_id === null) {
        return new OwnerBotReplyRoute();
    }
    throw new BotApiError("bot_service_unavailable", "The Bot conversation reply route is invalid", 503);
}

function conversationResponse(row: ConversationRow): object {
    const response = {
        behaviorRevisionId: row.behavior_revision_id,
        bindingId: row.binding_id,
        bindingRevision: row.binding_revision,
        botId: row.bot_id,
        clientConversationKey: row.client_conversation_key,
        conversationId: row.conversation_id,
        createdAt: new Date(row.created_at).toISOString(),
        creatorKind: row.creator_kind,
        creatorPrincipalId: row.creator_principal_id,
        lifecycle: row.lifecycle,
        sessionId: row.session_id,
        title: row.title,
    };
    if (
        row.creator_kind === "connection" &&
        typeof row.connection_id === "string" &&
        typeof row.reply_delivery_target_id === "string"
    ) {
        return {
            ...response,
            connectionId: row.connection_id,
            replyDeliveryTargetId: row.reply_delivery_target_id,
        };
    }
    return response;
}

function decodeProvisioningPayload(encoded: string): BotSessionProvisioning {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The Bot conversation provisioning is invalid", 503, {
            cause,
        });
    }
    try {
        return decodeBotSessionProvisioning(value);
    } catch (cause) {
        if (cause instanceof BotSessionRuntimeError) {
            throw new BotApiError("bot_service_unavailable", "The Bot conversation provisioning is invalid", 503, {
                cause,
            });
        }
        throw cause;
    }
}

function assertProvisioningMatches(row: ProvisioningOutboxRow, provisioning: BotSessionProvisioning): void {
    const route = replyRouteFromRow(row);
    if (
        row.outbox_bot_id !== row.bot_id ||
        row.outbox_subject_id !== row.conversation_id ||
        row.outbox_runtime_id !== provisioning.runtimeId ||
        provisioning.sessionId !== row.session_id ||
        provisioning.conversationId !== row.conversation_id ||
        provisioning.botId !== row.bot_id ||
        provisioning.behaviorRevisionId !== row.behavior_revision_id ||
        provisioning.bindingId !== row.binding_id ||
        provisioning.bindingRevision !== row.binding_revision ||
        provisioning.creatorKind !== row.creator_kind ||
        provisioning.creatorPrincipalId !== row.creator_principal_id ||
        provisioning.title !== row.title ||
        provisioning.replyRoute.kind !== route.kind
    ) {
        throw new BotApiError("bot_service_unavailable", "The Bot conversation provisioning is inconsistent", 503);
    }
    if (
        route instanceof BotConnectionReplyRoute &&
        (!(provisioning.replyRoute instanceof BotConnectionReplyRoute) ||
            provisioning.replyRoute.connectionId !== route.connectionId ||
            provisioning.replyRoute.deliveryTargetId !== route.deliveryTargetId)
    ) {
        throw new BotApiError("bot_service_unavailable", "The Bot conversation provisioning is inconsistent", 503);
    }
}

export class D1BotConversations {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly createOwnerConversation = async (
        principal: InboundBotOwnerPrincipal,
        binding: ApprovedBindingContext,
        clientConversationKey: string,
        title: string,
        now: number,
        signal: AbortSignal,
    ): Promise<BotConversationPlan> =>
        await this.createConversation(
            principal.scope,
            principal.botId,
            principal.kind,
            principal.principalId,
            "owner",
            clientConversationKey,
            title,
            new OwnerBotReplyRoute(),
            binding,
            now,
            signal,
        );

    readonly createConnectedConversation = async (
        principal: InboundBotConnectorPrincipal,
        binding: ApprovedBindingContext,
        clientConversationKey: string,
        title: string,
        replyDeliveryTargetId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<BotConversationPlan> =>
        await this.createConversation(
            principal.scope,
            principal.botId,
            principal.kind,
            principal.principalId,
            principal.connection.connectionId,
            clientConversationKey,
            title,
            new BotConnectionReplyRoute(principal.connection.connectionId, replyDeliveryTargetId),
            binding,
            now,
            signal,
        );

    readonly activateConversation = async (
        scope: ProjectScope,
        conversationId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedConversationId = validateIdentifier(conversationId, "conversation_id");
        const before = await this.readProvisioningOutbox(scope, normalizedConversationId, signal);
        if (before.lifecycle === "active" && before.outbox_state === "completed") {
            return conversationResponse(before);
        }
        if (before.lifecycle !== "provisioning" || before.outbox_state !== "pending") {
            throw new BotApiError("bot_service_unavailable", "The Bot conversation could not activate", 503);
        }
        await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_conversations SET lifecycle = 'active', activated_at = COALESCE(activated_at, ?)
                      WHERE conversation_id = ? AND lifecycle = 'provisioning'
                        AND EXISTS (
                          SELECT 1 FROM bot_control_outbox
                           WHERE subject_id = ? AND message_kind = 'conversation_provisioning'
                             AND state = 'pending'
                        )`,
                )
                .bind(now, normalizedConversationId, normalizedConversationId),
            this.#database
                .prepare(
                    `UPDATE bot_control_outbox SET state = 'completed', completed_at = COALESCE(completed_at, ?)
                      WHERE subject_id = ? AND message_kind = 'conversation_provisioning'
                        AND state = 'pending'
                        AND EXISTS (
                          SELECT 1 FROM bot_conversations
                           WHERE conversation_id = ? AND lifecycle = 'active'
                        )`,
                )
                .bind(now, normalizedConversationId, normalizedConversationId),
            this.audit(
                scope,
                before.bot_id,
                "runtime",
                before.outbox_runtime_id,
                "bot.conversation.activated",
                normalizedConversationId,
                { bindingId: before.binding_id },
                now,
            ),
        ]);
        signal.throwIfAborted();
        const activated = await this.readProvisioningOutbox(scope, normalizedConversationId, signal);
        if (activated.lifecycle !== "active" || activated.outbox_state !== "completed") {
            throw new BotApiError("bot_service_unavailable", "The Bot conversation could not activate", 503);
        }
        return conversationResponse(activated);
    };

    readonly listPendingProvisioning = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly BotConversationPlan[]> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT conversations.*,
                        outbox.bot_id AS outbox_bot_id,
                        outbox.subject_id AS outbox_subject_id,
                        outbox.runtime_id AS outbox_runtime_id,
                        outbox.state AS outbox_state,
                        outbox.payload
                   FROM bot_control_outbox AS outbox
                   INNER JOIN bot_conversations AS conversations
                     ON conversations.conversation_id = outbox.subject_id
                    AND conversations.bot_id = outbox.bot_id
                   INNER JOIN bots ON bots.bot_id = conversations.bot_id
                  WHERE bots.tenant_id = ? AND bots.project_id = ?
                    AND outbox.runtime_id = ?
                    AND outbox.message_kind = 'conversation_provisioning'
                    AND outbox.state = 'pending'
                    AND conversations.lifecycle = 'provisioning'
                  ORDER BY outbox.created_at, outbox.outbox_id LIMIT ?`,
            )
            .bind(
                scope.tenantId,
                scope.projectId,
                validateIdentifier(runtimeId, "runtime_id"),
                Math.min(Math.max(limit, 1), 100),
            )
            .all<ProvisioningOutboxRow>();
        signal.throwIfAborted();
        return rows.results.map((row) => this.planFromOutbox(row));
    };

    readonly failConversationProvisioning = async (
        scope: ProjectScope,
        conversationId: string,
        failureCode: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const normalizedConversationId = validateIdentifier(conversationId, "conversation_id");
        const row = await this.readProvisioningOutbox(scope, normalizedConversationId, signal);
        if (row.lifecycle === "closed" && row.outbox_state === "failed") {
            return;
        }
        if (row.lifecycle !== "provisioning" || row.outbox_state !== "pending") {
            throw new BotApiError("revision_conflict", "The Bot conversation provisioning state changed", 409);
        }
        await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE bot_conversations
                        SET lifecycle = 'closed', closed_at = ?, failure_code = ?
                      WHERE conversation_id = ? AND lifecycle = 'provisioning'`,
                )
                .bind(now, failureCode, normalizedConversationId),
            this.#database
                .prepare(
                    `UPDATE bot_control_outbox
                        SET state = 'failed', completed_at = ?, failure_code = ?
                      WHERE subject_id = ? AND message_kind = 'conversation_provisioning'
                        AND state = 'pending'`,
                )
                .bind(now, failureCode, normalizedConversationId),
            this.audit(
                scope,
                row.bot_id,
                "runtime",
                row.outbox_runtime_id,
                "bot.conversation.provisioning_failed",
                normalizedConversationId,
                { code: failureCode },
                now,
            ),
        ]);
        signal.throwIfAborted();
    };

    readonly authorizeConversation = async (
        principal: InboundBotPrincipal,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<AuthorizedBotConversation> => {
        const row = await this.readConversation(conversationId, signal);
        if (row.bot_id !== principal.botId || row.lifecycle !== "active") {
            throw new BotApiError("conversation_access_denied", "The Bot conversation is not accessible", 403);
        }
        if (
            principal instanceof InboundBotConnectorPrincipal &&
            row.connection_id !== principal.connection.connectionId
        ) {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation belongs to another connection",
                403,
            );
        }
        return new AuthorizedBotConversation(row);
    };

    readonly authorizeNewTurn = async (
        principal: InboundBotPrincipal,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<AuthorizedBotConversation> => {
        const conversation = await this.authorizeConversation(principal, conversationId, signal);
        const bot = await this.#database
            .prepare(`SELECT lifecycle FROM bots WHERE bot_id = ? AND tenant_id = ? AND project_id = ?`)
            .bind(principal.botId, principal.scope.tenantId, principal.scope.projectId)
            .first<{ readonly lifecycle: string }>();
        signal.throwIfAborted();
        if (bot?.lifecycle === "suspended") {
            throw new BotApiError("bot_suspended", "The Bot is suspended", 409);
        }
        if (bot?.lifecycle !== "active") {
            throw new BotApiError("bot_not_active", "The Bot is not active", 409);
        }
        return conversation;
    };

    readonly authorizeTurn = async (
        principal: InboundBotPrincipal,
        turnId: string,
        signal: AbortSignal,
    ): Promise<AuthorizedBotConversation> => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT conversation_id
                   FROM bot_execution_directory
                  WHERE bot_id = ? AND turn_id = ?`,
            )
            .bind(principal.botId, validateIdentifier(turnId, "turn_id"))
            .first<{ readonly conversation_id: string }>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot turn is not accessible", 403);
        }
        return await this.authorizeConversation(principal, row.conversation_id, signal);
    };

    readonly registerExecution = async (
        scope: ProjectScope,
        execution: BotExecutionRecord,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.#database
            .prepare(
                `INSERT OR IGNORE INTO bot_execution_directory (
                   execution_id, bot_id, conversation_id, turn_id, session_id,
                   behavior_revision_id, binding_id, binding_revision, runtime_id,
                   capability_id, created_at, deadline_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                execution.executionId,
                execution.botId,
                execution.conversationId,
                execution.turnId,
                execution.sessionId,
                execution.behaviorRevisionId,
                execution.bindingId,
                execution.bindingRevision,
                execution.runtimeId,
                execution.capabilityId,
                now,
                Date.parse(execution.deadlineAt),
            )
            .run();
        signal.throwIfAborted();
        const existing = await this.#database
            .prepare(
                `SELECT execution_id, bot_id, conversation_id, turn_id, session_id,
                        behavior_revision_id, binding_id, binding_revision,
                        runtime_id, capability_id
                   FROM bot_execution_directory WHERE execution_id = ?`,
            )
            .bind(execution.executionId)
            .first<{
                readonly behavior_revision_id: string;
                readonly binding_id: string;
                readonly binding_revision: number;
                readonly bot_id: string;
                readonly capability_id: string;
                readonly conversation_id: string;
                readonly execution_id: string;
                readonly runtime_id: string;
                readonly session_id: string;
                readonly turn_id: string;
            }>();
        signal.throwIfAborted();
        if (
            existing === null ||
            existing.bot_id !== execution.botId ||
            existing.conversation_id !== execution.conversationId ||
            existing.turn_id !== execution.turnId ||
            existing.session_id !== execution.sessionId ||
            existing.behavior_revision_id !== execution.behaviorRevisionId ||
            existing.binding_id !== execution.bindingId ||
            existing.binding_revision !== execution.bindingRevision ||
            existing.runtime_id !== execution.runtimeId ||
            existing.capability_id !== execution.capabilityId
        ) {
            throw new BotApiError("revision_conflict", "The Bot execution directory conflicts", 409);
        }
        await this.recordIdempotentAudit(
            scope,
            execution.botId,
            "runtime",
            execution.runtimeId,
            "bot.execution.created",
            execution.executionId,
            {
                bindingId: execution.bindingId,
                conversationId: execution.conversationId,
                turnId: execution.turnId,
            },
            now,
            signal,
        );
    };

    readonly recordOutboundAccepted = async (
        scope: ProjectScope,
        runtimeId: string,
        outbound: BotOutboundAcceptance,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const execution = await this.#database
            .prepare(
                `SELECT 1 AS present FROM bot_execution_directory
                  WHERE execution_id = ? AND bot_id = ? AND conversation_id = ?
                    AND turn_id = ? AND behavior_revision_id = ? AND binding_id = ?
                    AND binding_revision = ? AND runtime_id = ?`,
            )
            .bind(
                outbound.executionId,
                outbound.botId,
                outbound.conversationId,
                outbound.turnId,
                outbound.behaviorRevisionId,
                outbound.bindingId,
                outbound.bindingRevision,
                runtimeId,
            )
            .first<{ readonly present: number }>();
        signal.throwIfAborted();
        if (execution === null) {
            throw new BotApiError("revision_conflict", "The Bot outbound execution context conflicts", 409);
        }
        await this.recordIdempotentAudit(
            scope,
            outbound.botId,
            "bot_execution",
            outbound.executionId,
            "bot.outbound.accepted",
            outbound.outboundMessageId,
            {
                deliveryTargetId: outbound.deliveryTargetId,
                idempotencyKey: outbound.idempotencyKey,
            },
            now,
            signal,
        );
    };

    readonly readReplyRoute = async (conversationId: string, signal: AbortSignal): Promise<BotReplyRoute> =>
        replyRouteFromRow(await this.readConversation(conversationId, signal));

    private readonly createConversation = async (
        scope: ProjectScope,
        botId: string,
        creatorKind: string,
        creatorPrincipalId: string,
        creatorKey: string,
        clientConversationKey: string,
        title: string,
        replyRoute: BotReplyRoute,
        binding: ApprovedBindingContext,
        now: number,
        signal: AbortSignal,
    ): Promise<BotConversationPlan> => {
        signal.throwIfAborted();
        const conversationId = `bcv_${createRandomToken(18)}`;
        const sessionId = `ses_${createRandomToken(18)}`;
        const outboxId = `bco_${createRandomToken(18)}`;
        const connectionId = replyRoute instanceof BotConnectionReplyRoute ? replyRoute.connectionId : null;
        const targetId = replyRoute instanceof BotConnectionReplyRoute ? replyRoute.deliveryTargetId : null;
        const provisioning = new BotSessionProvisioning(
            sessionId,
            conversationId,
            botId,
            binding.behaviorRevisionId,
            binding.bindingId,
            binding.bindingRevision,
            binding.runtimeId,
            binding.agentRef,
            binding.workspaceRef,
            binding.agentConfigRevision,
            binding.localGrantId,
            creatorKind,
            creatorPrincipalId,
            title,
            binding.behaviorInstructions,
            binding.behaviorDigest,
            binding.allowedDeliveryTargets,
            binding.completionPolicy,
            replyRoute,
        );
        try {
            const results = await this.#database.batch([
                this.#database
                    .prepare(
                        `INSERT INTO bot_conversations (
                       conversation_id, bot_id, behavior_revision_id, binding_id,
                       binding_revision, session_id, creator_kind,
                       creator_principal_id, creator_key, connection_id,
                       reply_delivery_target_id, client_conversation_key,
                       title, lifecycle, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?)`,
                    )
                    .bind(
                        conversationId,
                        botId,
                        binding.behaviorRevisionId,
                        binding.bindingId,
                        binding.bindingRevision,
                        sessionId,
                        creatorKind,
                        creatorPrincipalId,
                        creatorKey,
                        connectionId,
                        targetId,
                        clientConversationKey,
                        title,
                        now,
                    ),
                this.#database
                    .prepare(
                        `INSERT INTO bot_control_outbox (
                           outbox_id, bot_id, subject_id, runtime_id,
                           message_kind, payload, state, created_at
                         ) VALUES (?, ?, ?, ?, 'conversation_provisioning', ?, 'pending', ?)`,
                    )
                    .bind(
                        outboxId,
                        botId,
                        conversationId,
                        binding.runtimeId,
                        encodeBotSessionProvisioning(provisioning),
                        now,
                    ),
                this.audit(
                    scope,
                    botId,
                    creatorKind,
                    creatorPrincipalId,
                    "bot.conversation.provisioning_requested",
                    conversationId,
                    { bindingId: binding.bindingId },
                    now,
                ),
            ]);
            signal.throwIfAborted();
            if (results.some((result) => result.meta.changes !== 1)) {
                throw new BotApiError("bot_service_unavailable", "The Bot conversation was not created", 503);
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof BotApiError) {
                throw cause;
            }
            const duplicate = await this.readDuplicateConversation(botId, creatorKey, clientConversationKey, signal);
            signal.throwIfAborted();
            const duplicateRoute = replyRouteFromRow(duplicate);
            if (
                duplicate.creator_kind !== creatorKind ||
                duplicate.creator_principal_id !== creatorPrincipalId ||
                duplicate.title !== title ||
                duplicateRoute.kind !== replyRoute.kind ||
                (duplicateRoute instanceof BotConnectionReplyRoute &&
                    (!(replyRoute instanceof BotConnectionReplyRoute) ||
                        duplicateRoute.connectionId !== replyRoute.connectionId ||
                        duplicateRoute.deliveryTargetId !== replyRoute.deliveryTargetId))
            ) {
                throw new BotApiError(
                    "idempotency_conflict",
                    "The conversation key was reused with different content",
                    409,
                    { cause },
                );
            }
            return this.planFromOutbox(duplicate);
        }
        const row = await this.readConversation(conversationId, signal);
        return new BotConversationPlan(provisioning, conversationResponse(row));
    };

    private readonly planFromOutbox = (row: ProvisioningOutboxRow): BotConversationPlan => {
        if (
            !(
                (row.lifecycle === "provisioning" && row.outbox_state === "pending") ||
                (row.lifecycle === "active" && row.outbox_state === "completed")
            )
        ) {
            if (row.lifecycle === "closed" && row.outbox_state === "failed") {
                throw new BotApiError("bot_not_active", "The Bot conversation provisioning failed", 409);
            }
            throw new BotApiError("bot_service_unavailable", "The Bot conversation provisioning is inconsistent", 503);
        }
        const provisioning = decodeProvisioningPayload(row.payload);
        assertProvisioningMatches(row, provisioning);
        return new BotConversationPlan(provisioning, conversationResponse(row));
    };

    private readonly readDuplicateConversation = async (
        botId: string,
        creatorKey: string,
        clientConversationKey: string,
        signal: AbortSignal,
    ): Promise<ProvisioningOutboxRow> => {
        const row = await this.#database
            .prepare(
                `SELECT conversations.*,
                        outbox.bot_id AS outbox_bot_id,
                        outbox.subject_id AS outbox_subject_id,
                        outbox.runtime_id AS outbox_runtime_id,
                        outbox.state AS outbox_state,
                        outbox.payload
                   FROM bot_conversations AS conversations
                   INNER JOIN bot_control_outbox AS outbox
                     ON outbox.subject_id = conversations.conversation_id
                    AND outbox.bot_id = conversations.bot_id
                    AND outbox.message_kind = 'conversation_provisioning'
                  WHERE conversations.bot_id = ? AND conversations.creator_key = ?
                    AND conversations.client_conversation_key = ?`,
            )
            .bind(botId, creatorKey, clientConversationKey)
            .first<ProvisioningOutboxRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("binding_not_approved", "The approved Bot binding changed", 409);
        }
        return row;
    };

    private readonly readProvisioningOutbox = async (
        scope: ProjectScope,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ProvisioningOutboxRow> => {
        const row = await this.#database
            .prepare(
                `SELECT conversations.*,
                        outbox.bot_id AS outbox_bot_id,
                        outbox.subject_id AS outbox_subject_id,
                        outbox.runtime_id AS outbox_runtime_id,
                        outbox.state AS outbox_state,
                        outbox.payload
                   FROM bot_conversations AS conversations
                   INNER JOIN bot_control_outbox AS outbox
                     ON outbox.subject_id = conversations.conversation_id
                    AND outbox.bot_id = conversations.bot_id
                    AND outbox.message_kind = 'conversation_provisioning'
                   INNER JOIN bots ON bots.bot_id = conversations.bot_id
                  WHERE conversations.conversation_id = ?
                    AND bots.tenant_id = ? AND bots.project_id = ?`,
            )
            .bind(conversationId, scope.tenantId, scope.projectId)
            .first<ProvisioningOutboxRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", 404);
        }
        return row;
    };

    private readonly readConversation = async (
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ConversationRow> => {
        const row = await this.#database
            .prepare(`SELECT * FROM bot_conversations WHERE conversation_id = ?`)
            .bind(validateIdentifier(conversationId, "conversation_id"))
            .first<ConversationRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", 404);
        }
        return row;
    };

    private readonly audit = (
        scope: ProjectScope,
        botId: string,
        actorKind: string,
        actorId: string,
        action: string,
        subjectId: string,
        details: Readonly<Record<string, string>>,
        now: number,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO bot_audit_events (
                   audit_id, tenant_id, project_id, bot_id, actor_kind,
                   actor_id, action, subject_id, details_json, recorded_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE changes() = 1`,
            )
            .bind(
                `aud_${createRandomToken(18)}`,
                scope.tenantId,
                scope.projectId,
                botId,
                actorKind,
                actorId,
                action,
                subjectId,
                JSON.stringify(details),
                now,
            );

    private readonly recordIdempotentAudit = async (
        scope: ProjectScope,
        botId: string,
        actorKind: string,
        actorId: string,
        action: string,
        subjectId: string,
        details: Readonly<Record<string, string>>,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const result = await this.#database
            .prepare(
                `INSERT INTO bot_audit_events (
                   audit_id, tenant_id, project_id, bot_id, actor_kind,
                   actor_id, action, subject_id, details_json, recorded_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                  WHERE NOT EXISTS (
                    SELECT 1 FROM bot_audit_events
                     WHERE bot_id = ? AND action = ? AND subject_id = ?
                  )`,
            )
            .bind(
                `aud_${createRandomToken(18)}`,
                scope.tenantId,
                scope.projectId,
                botId,
                actorKind,
                actorId,
                action,
                subjectId,
                JSON.stringify(details),
                now,
                botId,
                action,
                subjectId,
            )
            .run();
        signal.throwIfAborted();
        if (result.meta.changes === 1) {
            return;
        }
        const existing = await this.#database
            .prepare(
                `SELECT 1 AS present FROM bot_audit_events
                  WHERE bot_id = ? AND action = ? AND subject_id = ?`,
            )
            .bind(botId, action, subjectId)
            .first<{ readonly present: number }>();
        signal.throwIfAborted();
        if (existing === null) {
            throw new BotApiError("bot_service_unavailable", "The Bot audit event was not recorded", 503);
        }
    };
}
