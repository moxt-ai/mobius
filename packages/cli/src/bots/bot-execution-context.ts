import { randomBytes } from "node:crypto";
import { BotConnectionReplyRoute, type BotSessionPromptCommand } from "@moxt-ai/mobius-protocol";

import { LocalBotAuthorizationError } from "./local-bot-execution-authorizer.ts";

export class ActiveBotExecutionContext {
    readonly command: BotSessionPromptCommand;
    readonly contextHandle: string;

    constructor(contextHandle: string, command: BotSessionPromptCommand) {
        this.contextHandle = contextHandle;
        this.command = command;
    }

    readonly resolveTarget = (target: string): string => {
        if (target === "current") {
            if (!(this.command.replyRoute instanceof BotConnectionReplyRoute)) {
                throw new LocalBotAuthorizationError(
                    "delivery_target_not_allowed",
                    "This Bot conversation has no external reply target",
                );
            }
            return this.command.replyRoute.deliveryTargetId;
        }
        const resolved = this.command.allowedDeliveryTargets.find((candidate) => candidate.alias === target);
        if (resolved === undefined) {
            throw new LocalBotAuthorizationError(
                "delivery_target_not_allowed",
                "The named Bot delivery target is not approved",
            );
        }
        return resolved.deliveryTargetId;
    };
}

export class BotExecutionContextLease {
    readonly context: ActiveBotExecutionContext;
    readonly #release: () => void;
    #released = false;

    constructor(context: ActiveBotExecutionContext, release: () => void) {
        this.context = context;
        this.#release = release;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#release();
    };
}

export class BotExecutionContextRegistry {
    readonly #activeByHandle = new Map<string, ActiveBotExecutionContext>();
    readonly #handlesBySession = new Map<string, string>();
    readonly #inactiveHandles = new Set<string>();

    readonly activate = (command: BotSessionPromptCommand): BotExecutionContextLease => {
        let handle = this.#handlesBySession.get(command.sessionId);
        if (handle === undefined) {
            handle = `ctx_${Buffer.from(randomBytes(32)).toString("base64url")}`;
            this.#handlesBySession.set(command.sessionId, handle);
        }
        if (this.#activeByHandle.has(handle)) {
            throw new LocalBotAuthorizationError("session_busy", "The Bot execution context is already active");
        }
        const context = new ActiveBotExecutionContext(handle, command);
        this.#inactiveHandles.delete(handle);
        this.#activeByHandle.set(handle, context);
        return new BotExecutionContextLease(context, () => {
            if (this.#activeByHandle.get(handle) === context) {
                this.#activeByHandle.delete(handle);
                this.#inactiveHandles.add(handle);
            }
        });
    };

    readonly read = (handle: string): ActiveBotExecutionContext => {
        const context = this.#activeByHandle.get(handle);
        if (context === undefined) {
            if (this.#inactiveHandles.has(handle)) {
                throw new LocalBotAuthorizationError(
                    "execution_capability_expired",
                    "The Bot execution capability has expired",
                );
            }
            throw new LocalBotAuthorizationError(
                "execution_context_required",
                "An active Bot execution context is required",
            );
        }
        return context;
    };
}
