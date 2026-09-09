import { BotConnectionReplyRoute } from "@moxt-ai/mobius-protocol";
import type { BotOwnerAccess, InboundBotPrincipal } from "../entity/bot/bot-access.ts";
import type {
    BotConversationRecord as ConversationRow,
    BotProvisioningOutboxRecord as ProvisioningOutboxRow,
} from "../entity/bot/bot-conversation.ts";
import type { BotExecutionRecord, BotOutboundAcceptance, BotSessionProvisioning } from "../entity/bot/bot-session.ts";
import { encodeBotSessionProvisioning } from "../entity/bot/bot-session-provisioning-codec.ts";
import type { ProjectScope } from "../entity/do/session.ts";
import { createRandomToken, validateIdentifier } from "../entity/pairing/pairing.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { SqlDatabase, SqlStatement } from "../infra/sql-database.ts";
import type { TenantContext } from "../infra/tenant-sharding-directory.ts";

export class BotConversationStorage {
    readonly #database: SqlDatabase;

    constructor(tenant: TenantContext, databases: DatabaseResolver) {
        this.#database = databases.resolve(tenant.tenantSharding);
    }

    readonly listForOwner = async (access: BotOwnerAccess, signal: AbortSignal) => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(`SELECT conversations.* FROM bot_conversations AS conversations
                INNER JOIN bots ON bots.bot_id = conversations.bot_id
                WHERE conversations.bot_id = ? AND bots.tenant_id = ? AND bots.project_id = ?
                  AND (conversations.creator_kind <> 'owner'
                    OR EXISTS (SELECT 1 FROM bot_execution_directory AS executions
                        WHERE executions.conversation_id = conversations.conversation_id)
                    OR EXISTS (SELECT 1 FROM bot_owner_conversation_drafts AS drafts
                        WHERE drafts.bot_id = conversations.bot_id
                          AND drafts.conversation_id = conversations.conversation_id))
                ORDER BY conversations.created_at DESC, conversations.conversation_id DESC`)
            .bind(access.botId, access.scope.tenantId, access.scope.projectId)
            .all<ConversationRow>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly writeConversationActivation = async (
        scope: ProjectScope,
        before: ProvisioningOutboxRow,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const normalizedConversationId = before.conversation_id;
        await this.#database.batch(
            [
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
            ],
            signal,
        );
        signal.throwIfAborted();
    };

    readonly readPendingProvisioning = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly ProvisioningOutboxRow[]> => {
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
            .bind(scope.tenantId, scope.projectId, validateIdentifier(runtimeId, "runtime_id"), limit)
            .all<ProvisioningOutboxRow>(signal);
        signal.throwIfAborted();
        return rows.results;
    };

    readonly writeProvisioningFailure = async (
        scope: ProjectScope,
        row: ProvisioningOutboxRow,
        failureCode: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const normalizedConversationId = row.conversation_id;
        await this.#database.batch(
            [
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
                this.#database
                    .prepare(`DELETE FROM bot_owner_conversation_drafts WHERE conversation_id = ?`)
                    .bind(normalizedConversationId),
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
            ],
            signal,
        );
        signal.throwIfAborted();
    };

    readonly readExecutionState = async (
        principal: InboundBotPrincipal,
        bindingId: string,
        bindingRevision: number,
        signal: AbortSignal,
    ) => {
        const row = await this.#database
            .prepare(
                `SELECT bindings.lifecycle AS binding_lifecycle, channels.status AS runtime_status
             FROM bot_execution_bindings AS bindings
             INNER JOIN bots ON bots.bot_id = bindings.bot_id
             LEFT JOIN pairing_channels AS channels ON channels.runtime_id = bindings.runtime_id
               AND channels.tenant_id = bots.tenant_id AND channels.project_id = bots.project_id
             WHERE bindings.binding_id = ? AND bindings.bot_id = ? AND bindings.binding_revision = ?
               AND bots.tenant_id = ? AND bots.project_id = ?`,
            )
            .bind(bindingId, principal.botId, bindingRevision, principal.scope.tenantId, principal.scope.projectId)
            .first<{ readonly binding_lifecycle: string; readonly runtime_status: string | null }>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readBotLifecycle = async (principal: InboundBotPrincipal, signal: AbortSignal) => {
        const bot = await this.#database
            .prepare(`SELECT lifecycle FROM bots WHERE bot_id = ? AND tenant_id = ? AND project_id = ?`)
            .bind(principal.botId, principal.scope.tenantId, principal.scope.projectId)
            .first<{ readonly lifecycle: string }>(signal);
        signal.throwIfAborted();
        return bot;
    };

    readonly readTurnConversation = async (botId: string, turnId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT conversation_id
                   FROM bot_execution_directory
                  WHERE bot_id = ? AND turn_id = ?`,
            )
            .bind(botId, turnId)
            .first<{ readonly conversation_id: string }>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly insertExecution = async (
        execution: BotExecutionRecord,
        registration: { readonly kind: "owner"; readonly title: string } | { readonly kind: "connection" },
        now: number,
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        await this.#database.batch(
            [
                this.#database
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
                    ),
                ...(registration.kind === "owner"
                    ? [
                          this.#database
                              .prepare(
                                  `UPDATE bot_conversations SET title = ?
                     WHERE bot_id = ? AND conversation_id = ? AND creator_kind = 'owner'
                       AND EXISTS (SELECT 1 FROM bot_owner_conversation_drafts AS drafts
                         WHERE drafts.bot_id = bot_conversations.bot_id AND drafts.conversation_id = bot_conversations.conversation_id)
                       AND EXISTS (SELECT 1 FROM bot_execution_directory AS executions
                         WHERE executions.execution_id = ? AND executions.bot_id = bot_conversations.bot_id
                           AND executions.conversation_id = bot_conversations.conversation_id)`,
                              )
                              .bind(
                                  registration.title,
                                  execution.botId,
                                  execution.conversationId,
                                  execution.executionId,
                              ),
                          this.#database
                              .prepare(
                                  `DELETE FROM bot_owner_conversation_drafts WHERE bot_id = ? AND conversation_id = ?
                       AND EXISTS (SELECT 1 FROM bot_execution_directory WHERE execution_id = ? AND bot_id = ? AND conversation_id = ?)`,
                              )
                              .bind(
                                  execution.botId,
                                  execution.conversationId,
                                  execution.executionId,
                                  execution.botId,
                                  execution.conversationId,
                              ),
                      ]
                    : []),
            ],
            signal,
        );
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
            }>(signal);
        signal.throwIfAborted();
        return existing;
    };

    readonly recordExecutionAudit = async (
        scope: ProjectScope,
        execution: BotExecutionRecord,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        return await this.recordIdempotentAudit(
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

    readonly hasOutboundExecution = async (
        runtimeId: string,
        outbound: BotOutboundAcceptance,
        signal: AbortSignal,
    ): Promise<boolean> => {
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
            .first<{ readonly present: number }>(signal);
        signal.throwIfAborted();
        return execution !== null;
    };

    readonly recordOutboundAudit = async (
        scope: ProjectScope,
        outbound: BotOutboundAcceptance,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        return await this.recordIdempotentAudit(
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

    readonly writeConversation = async (
        scope: ProjectScope,
        creatorKey: string,
        clientConversationKey: string,
        provisioning: BotSessionProvisioning,
        outboxId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const { conversationId, sessionId, botId, creatorKind, creatorPrincipalId, title, replyRoute } = provisioning;
        const binding = provisioning;
        const connectionId = replyRoute instanceof BotConnectionReplyRoute ? replyRoute.connectionId : null;
        const targetId = replyRoute instanceof BotConnectionReplyRoute ? replyRoute.deliveryTargetId : null;
        const results = await this.#database.batch(
            [
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
                ...(creatorKind === "owner"
                    ? [
                          this.#database
                              .prepare(
                                  `INSERT INTO bot_owner_conversation_drafts (bot_id, conversation_id, created_at) VALUES (?, ?, ?)`,
                              )
                              .bind(botId, conversationId, now),
                      ]
                    : []),
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
            ],
            signal,
        );
        signal.throwIfAborted();
        return results.every((result) => result.meta.changes === 1);
    };

    readonly readOwnerDraft = async (botId: string, signal: AbortSignal): Promise<ProvisioningOutboxRow | null> => {
        const row = await this.#database
            .prepare(
                `SELECT conversations.*, outbox.bot_id AS outbox_bot_id, outbox.subject_id AS outbox_subject_id,
             outbox.runtime_id AS outbox_runtime_id, outbox.state AS outbox_state, outbox.payload
             FROM bot_owner_conversation_drafts AS drafts
             INNER JOIN bot_conversations AS conversations ON conversations.bot_id = drafts.bot_id AND conversations.conversation_id = drafts.conversation_id
             INNER JOIN bot_control_outbox AS outbox ON outbox.subject_id = conversations.conversation_id
               AND outbox.bot_id = conversations.bot_id AND outbox.message_kind = 'conversation_provisioning'
             WHERE drafts.bot_id = ?`,
            )
            .bind(botId)
            .first<ProvisioningOutboxRow>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readDuplicateConversation = async (
        botId: string,
        creatorKey: string,
        clientConversationKey: string,
        signal: AbortSignal,
    ): Promise<ProvisioningOutboxRow | null> => {
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
            .first<ProvisioningOutboxRow>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readProvisioningOutbox = async (
        scope: ProjectScope,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ProvisioningOutboxRow | null> => {
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
            .first<ProvisioningOutboxRow>(signal);
        signal.throwIfAborted();
        return row;
    };

    readonly readConversation = async (
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ConversationRow | null> => {
        const row = await this.#database
            .prepare(`SELECT * FROM bot_conversations WHERE conversation_id = ?`)
            .bind(validateIdentifier(conversationId, "conversation_id"))
            .first<ConversationRow>(signal);
        signal.throwIfAborted();
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
    ): SqlStatement =>
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
    ): Promise<boolean> => {
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
            .run(signal);
        signal.throwIfAborted();
        if (result.meta.changes === 1) {
            return true;
        }
        const existing = await this.#database
            .prepare(
                `SELECT 1 AS present FROM bot_audit_events
                  WHERE bot_id = ? AND action = ? AND subject_id = ?`,
            )
            .bind(botId, action, subjectId)
            .first<{ readonly present: number }>(signal);
        signal.throwIfAborted();
        return existing !== null;
    };
}
