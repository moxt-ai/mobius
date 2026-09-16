import type { BotSessionRuntime } from "../../entity/bot/bot-session.ts";
import { BotSessionRuntimeError } from "../../entity/bot/bot-session.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import { unmeasuredOperationTiming } from "../../infra/operation-timing.ts";
import type { BotRuntimeService } from "../bot/bot-runtime-service.ts";
import type { ChannelPeers } from "./channel-actor.ts";

export interface RuntimeRecoveryContext {
    readonly services: {
        readonly bots: Pick<
            BotRuntimeService,
            "listPendingControl" | "listPendingProvisioning" | "activateConversation" | "failConversationProvisioning"
        >;
    };
    readonly gateways: {
        readonly botSessions: BotSessionRuntime;
        readonly peers: ChannelPeers;
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
    };
}

export class RuntimeRecoveryService {
    readonly #cx: RuntimeRecoveryContext;

    constructor(cx: RuntimeRecoveryContext) {
        this.#cx = cx;
    }

    readonly dispatch = async (runtimeId: string, scope: ProjectScope, signal: AbortSignal): Promise<void> => {
        const messages = await this.#cx.services.bots.listPendingControl(scope, runtimeId, 100, signal);
        const daemon = this.#cx.gateways.peers.daemons().find((socket) => socket.isOpen());
        if (daemon === undefined) {
            return;
        }
        for (const message of messages) {
            signal.throwIfAborted();
            daemon.send(message);
        }
    };

    readonly reconcile = async (runtimeId: string, scope: ProjectScope, signal: AbortSignal): Promise<void> => {
        const plans = await this.#cx.services.bots.listPendingProvisioning(scope, runtimeId, 100, signal);
        let retryPending = plans.length === 100;
        for (const plan of plans) {
            signal.throwIfAborted();
            try {
                await this.#cx.gateways.botSessions.provisionConversation(
                    scope,
                    plan.provisioning,
                    Date.now(),
                    signal,
                    unmeasuredOperationTiming,
                );
                await this.#cx.services.bots.activateConversation(
                    scope,
                    plan.provisioning.conversationId,
                    Date.now(),
                    signal,
                );
            } catch (error) {
                signal.throwIfAborted();
                if (
                    error instanceof BotSessionRuntimeError &&
                    (error.code === "conversation_access_denied" || error.code === "session_conflict")
                ) {
                    await this.#cx.services.bots.failConversationProvisioning(
                        scope,
                        plan.provisioning.conversationId,
                        error.code,
                        Date.now(),
                        signal,
                    );
                    continue;
                }
                console.error("Bot conversation provisioning recovery failed", error);
                retryPending = true;
            }
        }
        if (retryPending) {
            await this.#cx.gateways.schedule(Date.now() + 30_000, signal);
        }
    };
}
