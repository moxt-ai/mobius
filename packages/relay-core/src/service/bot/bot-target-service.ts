import type { BotDeliveryRoute } from "../../entity/bot/bot-delivery-route.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import type { BotConnectionStorage } from "../../storage/bot-connection-storage.ts";

export class BotTargetService {
    readonly #storage: BotConnectionStorage;

    constructor(storage: BotConnectionStorage) {
        this.#storage = storage;
    }

    readonly authorizeOutboundTarget = async (
        botId: string,
        bindingId: string,
        targetId: string,
        signal: AbortSignal,
    ): Promise<BotDeliveryRoute> => {
        const target = await this.#storage.readTarget(targetId, signal);
        if (target === null) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target does not exist", "not-found");
        }
        if (target.bot_id !== botId) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The delivery target belongs to another Bot",
                "access-denied",
            );
        }
        if (!(await this.#storage.hasBindingTarget(botId, bindingId, target.delivery_target_id, signal))) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The delivery target is outside the approved binding",
                "access-denied",
            );
        }
        if (target.lifecycle !== "active" || target.connection_lifecycle !== "active" || target.owner_approved !== 1) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target is unavailable", "conflict");
        }
        return {
            alias: target.alias,
            botId: target.bot_id,
            connectionId: target.connection_id,
            deliveryTargetId: target.delivery_target_id,
            policyRevision: target.outbound_policy_revision,
        };
    };

    readonly authorizeConversationReplyTarget = async (
        botId: string,
        connectionId: string,
        targetId: string,
        signal: AbortSignal,
    ): Promise<BotDeliveryRoute> => {
        const target = await this.#storage.readTarget(targetId, signal);
        if (target === null) {
            throw new BotApiError("delivery_target_unavailable", "The delivery target does not exist", "not-found");
        }
        if (target.bot_id !== botId || target.connection_id !== connectionId) {
            throw new BotApiError(
                "delivery_target_not_allowed",
                "The reply target does not belong to this Bot connection",
                "access-denied",
            );
        }
        if (target.lifecycle !== "active" || target.connection_lifecycle !== "active" || target.owner_approved !== 1) {
            throw new BotApiError("delivery_target_unavailable", "The reply target is unavailable", "conflict");
        }
        return {
            alias: target.alias,
            botId: target.bot_id,
            connectionId: target.connection_id,
            deliveryTargetId: target.delivery_target_id,
            policyRevision: target.outbound_policy_revision,
        };
    };
}
