import type { BotDeliveryRoute } from "../entity/bot/bot-delivery-route.ts";
import type { BotOutboundAcceptance } from "../entity/bot/bot-session.ts";

export interface BotConnectionGateway {
    readonly enqueue: (route: BotDeliveryRoute, message: BotOutboundAcceptance, signal: AbortSignal) => Promise<object>;
    readonly read: (
        connectionId: string,
        after: number,
        limit: number,
        now: number,
        activeDeliveryTargetIds: readonly string[],
        signal: AbortSignal,
    ) => Promise<object>;
    readonly delivered: (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly retryableFailure: (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        code: string,
        retryAt: number,
        now: number,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly terminalFailure: (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        code: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<object>;
}
