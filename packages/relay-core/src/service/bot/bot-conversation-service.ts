import { BotConnectionReplyRoute, type BotReplyRoute, OwnerBotReplyRoute } from "@moxt-ai/mobius-protocol";
import type { BotConnectionAccess, ProjectBotAccess } from "../../entity/bot/bot-access.ts";
import type { ApprovedBindingContext } from "../../entity/bot/bot-binding.ts";
import {
    assertProvisioningMatches,
    type BotConversationPlan,
    type BotProvisioningOutboxRecord,
    conversationResponse,
    decodeProvisioningPayload,
    replyRouteFromRow,
} from "../../entity/bot/bot-conversation.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import {
    type BotExecutionRecord,
    type BotOutboundAcceptance,
    BotSessionProvisioning,
} from "../../entity/bot/bot-session.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import { createRandomToken, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { BotConversationStorage } from "../../storage/bot-conversation-storage.ts";

export class BotConversationService {
    readonly #storage: BotConversationStorage;

    constructor(storage: BotConversationStorage) {
        this.#storage = storage;
    }

    readonly registerExecution = async (
        scope: ProjectScope,
        execution: BotExecutionRecord,
        registration: { readonly kind: "owner"; readonly title: string } | { readonly kind: "connection" },
        now: number,
        signal: AbortSignal,
    ) => {
        const existing = await this.#storage.insertExecution(execution, registration, now, signal);
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
            throw new BotApiError("revision_conflict", "The Bot execution directory conflicts", "conflict");
        }
        if (!(await this.#storage.recordExecutionAudit(scope, execution, now, signal))) {
            throw new BotApiError("bot_service_unavailable", "The Bot audit event was not recorded", "unavailable");
        }
    };

    readonly recordOutboundAccepted = async (
        scope: ProjectScope,
        runtimeId: string,
        outbound: BotOutboundAcceptance,
        now: number,
        signal: AbortSignal,
    ) => {
        if (!(await this.#storage.hasOutboundExecution(runtimeId, outbound, signal))) {
            throw new BotApiError("revision_conflict", "The Bot outbound execution context conflicts", "conflict");
        }
        if (!(await this.#storage.recordOutboundAudit(scope, outbound, now, signal))) {
            throw new BotApiError("bot_service_unavailable", "The Bot audit event was not recorded", "unavailable");
        }
    };

    readonly createProjectConversation = async (
        access: ProjectBotAccess,
        binding: ApprovedBindingContext,
        key: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const duplicate = await this.#storage.readDuplicateConversation(access.botId, "owner", key, signal);
        if (duplicate !== null) {
            return this.planFromOutbox(duplicate);
        }
        const draft = await this.#storage.readOwnerDraft(access.botId, signal);
        if (draft !== null) {
            return this.planFromOutbox(draft);
        }
        return this.createConversation(
            access.scope,
            access.botId,
            access.conversationActorKind,
            access.actor.actorId,
            "owner",
            key,
            "New chat",
            new OwnerBotReplyRoute(),
            binding,
            now,
            signal,
        );
    };

    readonly createConnectedConversation = (
        access: BotConnectionAccess,
        binding: ApprovedBindingContext,
        key: string,
        title: string,
        targetId: string,
        now: number,
        signal: AbortSignal,
    ) =>
        this.createConversation(
            access.scope,
            access.botId,
            access.conversationActorKind,
            access.actor.actorId,
            access.connectionId,
            key,
            title,
            new BotConnectionReplyRoute(access.connectionId, targetId),
            binding,
            now,
            signal,
        );

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
            if (
                !(await this.#storage.writeConversation(
                    scope,
                    creatorKey,
                    clientConversationKey,
                    provisioning,
                    outboxId,
                    now,
                    signal,
                ))
            ) {
                throw new BotApiError("bot_service_unavailable", "The Bot conversation was not created", "unavailable");
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof BotApiError) {
                throw cause;
            }
            const duplicate = await this.#storage.readDuplicateConversation(
                botId,
                creatorKey,
                clientConversationKey,
                signal,
            );
            if (duplicate === null) {
                if (creatorKind === "owner") {
                    const draft = await this.#storage.readOwnerDraft(botId, signal);
                    if (draft !== null) {
                        return this.planFromOutbox(draft);
                    }
                }
                throw new BotApiError(
                    "bot_service_unavailable",
                    "The Bot conversation could not be created",
                    "unavailable",
                    { cause },
                );
            }
            if (creatorKind === "owner") {
                return this.planFromOutbox(duplicate);
            }
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
                    "conflict",
                    { cause },
                );
            }
            return this.planFromOutbox(duplicate);
        }
        const row = await this.readConversation(conversationId, signal);
        return { provisioning, response: conversationResponse(row) };
    };

    private readonly planFromOutbox = (row: BotProvisioningOutboxRecord): BotConversationPlan => {
        if (
            !(
                (row.lifecycle === "provisioning" && row.outbox_state === "pending") ||
                (row.lifecycle === "active" && row.outbox_state === "completed")
            )
        ) {
            if (row.lifecycle === "closed" && row.outbox_state === "failed") {
                throw new BotApiError("bot_not_active", "The Bot conversation provisioning failed", "conflict");
            }
            throw new BotApiError(
                "bot_service_unavailable",
                "The Bot conversation provisioning is inconsistent",
                "unavailable",
            );
        }
        const provisioning = decodeProvisioningPayload(row.payload);
        assertProvisioningMatches(row, provisioning);
        return { provisioning, response: conversationResponse(row) };
    };

    readonly listPendingProvisioning = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ) => {
        const rows = await this.#storage.readPendingProvisioning(
            scope,
            runtimeId,
            Math.min(Math.max(limit, 1), 100),
            signal,
        );
        return rows.map(this.planFromOutbox);
    };

    readonly activateConversation = async (
        scope: ProjectScope,
        conversationId: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const id = validateIdentifier(conversationId, "conversation_id");
        const before = await this.#storage.readProvisioningOutbox(scope, id, signal);
        if (before === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", "not-found");
        }
        if (before.lifecycle === "active" && before.outbox_state === "completed") {
            return conversationResponse(before);
        }
        if (before.lifecycle !== "provisioning" || before.outbox_state !== "pending") {
            throw new BotApiError("bot_service_unavailable", "The Bot conversation could not activate", "unavailable");
        }
        await this.#storage.writeConversationActivation(scope, before, now, signal);
        const activated = await this.#storage.readProvisioningOutbox(scope, id, signal);
        if (activated === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", "not-found");
        }
        if (activated.lifecycle !== "active" || activated.outbox_state !== "completed") {
            throw new BotApiError("bot_service_unavailable", "The Bot conversation could not activate", "unavailable");
        }
        return conversationResponse(activated);
    };

    readonly failConversationProvisioning = async (
        scope: ProjectScope,
        conversationId: string,
        code: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const row = await this.#storage.readProvisioningOutbox(
            scope,
            validateIdentifier(conversationId, "conversation_id"),
            signal,
        );
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", "not-found");
        }
        if (row.lifecycle === "closed" && row.outbox_state === "failed") {
            return;
        }
        if (row.lifecycle !== "provisioning" || row.outbox_state !== "pending") {
            throw new BotApiError("revision_conflict", "The Bot conversation provisioning state changed", "conflict");
        }
        await this.#storage.writeProvisioningFailure(scope, row, code, now, signal);
    };

    readonly readConversation = async (conversationId: string, signal: AbortSignal) => {
        const row = await this.#storage.readConversation(conversationId, signal);
        if (row === null) {
            throw new BotApiError("conversation_access_denied", "The Bot conversation does not exist", "not-found");
        }
        return row;
    };

    readonly readReplyRoute = async (conversationId: string, signal: AbortSignal) =>
        replyRouteFromRow(await this.readConversation(conversationId, signal));
}
