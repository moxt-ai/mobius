import type { ProjectScope } from "../../entity/do/session.ts";
import type { BotConversationService } from "./bot-conversation-service.ts";
import type { BotTargetService } from "./bot-target-service.ts";

export class BotRuntimeService {
    readonly #targets: BotTargetService;
    readonly #provisioning: BotConversationService;
    constructor(cx: {
        readonly services: { readonly targets: BotTargetService; readonly conversations: BotConversationService };
    }) {
        this.#targets = cx.services.targets;
        this.#provisioning = cx.services.conversations;
    }
    readonly listPendingProvisioning = (scope: ProjectScope, runtimeId: string, limit: number, signal: AbortSignal) =>
        this.#provisioning.listPendingProvisioning(scope, runtimeId, limit, signal);
    readonly activateConversation = (scope: ProjectScope, conversationId: string, now: number, signal: AbortSignal) =>
        this.#provisioning.activateConversation(scope, conversationId, now, signal);
    readonly failConversationProvisioning = (
        scope: ProjectScope,
        conversationId: string,
        code: string,
        now: number,
        signal: AbortSignal,
    ) => this.#provisioning.failConversationProvisioning(scope, conversationId, code, now, signal);
    readonly authorizeOutboundTarget = (botId: string, bindingId: string, targetId: string, signal: AbortSignal) =>
        this.#targets.authorizeOutboundTarget(botId, bindingId, targetId, signal);
}
