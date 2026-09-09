import type { BotExecutionBindingApprovedEvent, BotExecutionBindingUnavailableEvent } from "@moxt-ai/mobius-protocol";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type { BotControlStorage } from "../../storage/bot-control-storage.ts";
import type { BotConversationService } from "./bot-conversation-service.ts";
import type { BotTargetService } from "./bot-target-service.ts";

export class BotRuntimeService {
    readonly #control: BotControlStorage;
    readonly #targets: BotTargetService;
    readonly #provisioning: BotConversationService;
    constructor(cx: {
        readonly services: { readonly targets: BotTargetService; readonly conversations: BotConversationService };
        readonly storages: {
            readonly control: BotControlStorage;
        };
    }) {
        this.#control = cx.storages.control;
        this.#targets = cx.services.targets;
        this.#provisioning = cx.services.conversations;
    }
    readonly approveBinding = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingApprovedEvent,
        now: number,
        signal: AbortSignal,
    ) => {
        if (await this.#control.hasApprovedBindingResponse(scope, runtimeId, event, signal)) {
            return;
        }
        if ((await this.#control.readRequestedBinding(scope, runtimeId, event, signal)) === null) {
            throw new BotApiError("revision_conflict", "The Bot binding response is stale", "conflict");
        }
        if (!(await this.#control.writeBindingApproval(scope, runtimeId, event, now, signal))) {
            throw new BotApiError("revision_conflict", "The Bot binding approval conflicted", "conflict");
        }
    };
    readonly rejectBinding = async (
        scope: ProjectScope,
        runtimeId: string,
        event: BotExecutionBindingUnavailableEvent,
        now: number,
        signal: AbortSignal,
    ) => {
        if (await this.#control.hasUnavailableBindingResponse(scope, runtimeId, event, signal)) {
            return;
        }
        if ((await this.#control.readRequestedBinding(scope, runtimeId, event, signal)) === null) {
            throw new BotApiError("revision_conflict", "The Bot binding response is stale", "conflict");
        }
        if (!(await this.#control.writeBindingRejection(scope, runtimeId, event, now, signal))) {
            throw new BotApiError("revision_conflict", "The Bot binding response conflicted", "conflict");
        }
    };
    readonly listPendingControl = (scope: ProjectScope, runtimeId: string, limit: number, signal: AbortSignal) =>
        this.#control.listPendingControl(scope, runtimeId, Math.min(Math.max(limit, 1), 100), signal);
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
