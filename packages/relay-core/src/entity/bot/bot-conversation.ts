import { BotConnectionReplyRoute, type BotReplyRoute, OwnerBotReplyRoute } from "@moxt-ai/mobius-protocol";
import { BotApiError } from "./bot-error.ts";
import { type BotSessionProvisioning, BotSessionRuntimeError } from "./bot-session.ts";
import { decodeBotSessionProvisioning } from "./bot-session-provisioning-codec.ts";

export interface BotConversationRecord {
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

export interface BotProvisioningOutboxRecord extends BotConversationRecord {
    readonly outbox_bot_id: string;
    readonly outbox_runtime_id: string;
    readonly outbox_state: string;
    readonly outbox_subject_id: string;
    readonly payload: string;
}

export interface BotConversationPlan {
    readonly provisioning: BotSessionProvisioning;
    readonly response: object;
}

export function replyRouteFromRow(row: BotConversationRecord): BotReplyRoute {
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
    throw new BotApiError("bot_service_unavailable", "The Bot conversation reply route is invalid", "unavailable");
}

export function decodeProvisioningPayload(encoded: string): BotSessionProvisioning {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError(
            "bot_service_unavailable",
            "The Bot conversation provisioning is invalid",
            "unavailable",
            {
                cause,
            },
        );
    }
    try {
        return decodeBotSessionProvisioning(value);
    } catch (cause) {
        if (cause instanceof BotSessionRuntimeError) {
            throw new BotApiError(
                "bot_service_unavailable",
                "The Bot conversation provisioning is invalid",
                "unavailable",
                {
                    cause,
                },
            );
        }
        throw cause;
    }
}

export function assertProvisioningMatches(
    row: BotProvisioningOutboxRecord,
    provisioning: BotSessionProvisioning,
): void {
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
        (provisioning.title !== row.title &&
            !(row.creator_kind === "owner" && row.lifecycle === "active" && provisioning.title === "New chat")) ||
        provisioning.replyRoute.kind !== route.kind
    ) {
        throw new BotApiError(
            "bot_service_unavailable",
            "The Bot conversation provisioning is inconsistent",
            "unavailable",
        );
    }
    if (
        route instanceof BotConnectionReplyRoute &&
        (!(provisioning.replyRoute instanceof BotConnectionReplyRoute) ||
            provisioning.replyRoute.connectionId !== route.connectionId ||
            provisioning.replyRoute.deliveryTargetId !== route.deliveryTargetId)
    ) {
        throw new BotApiError(
            "bot_service_unavailable",
            "The Bot conversation provisioning is inconsistent",
            "unavailable",
        );
    }
}

export function conversationResponse(row: BotConversationRecord): object {
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
        return { ...response, connectionId: row.connection_id, replyDeliveryTargetId: row.reply_delivery_target_id };
    }
    return response;
}
