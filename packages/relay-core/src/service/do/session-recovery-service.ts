import { BotApiError } from "../../entity/bot/bot-error.ts";
import { BotOutboundAcceptance, type PendingBotOutbound } from "../../entity/bot/bot-session.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type { BotConnectionGateway } from "../../gateway/bot-connection-gateway.ts";
import type { TenantContext, TenantShardingDirectory } from "../../infra/tenant-sharding-directory.ts";
import type { BotTargetService } from "../bot/bot-target-service.ts";
import type { BotSessionService } from "./bot-session-service.ts";
import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

interface SessionRecoveryContext {
    readonly runtime: SqliteSessionRuntime;
    readonly bots: BotSessionService;
    readonly services: {
        readonly forTenant: (tenant: TenantContext) => { readonly targets: BotTargetService };
    };
    readonly tenants: TenantShardingDirectory;
    readonly connections: BotConnectionGateway;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}

export class SessionRecoveryService {
    readonly #cx: SessionRecoveryContext;

    constructor(cx: SessionRecoveryContext) {
        this.#cx = cx;
    }

    readonly schedule = (signal: AbortSignal) => this.#cx.schedule(Date.now(), signal);

    readonly recover = async (signal: AbortSignal): Promise<void> => {
        const rows = this.#cx.runtime.listRecoverySessions();
        let pending = false;
        for (const { scope, sessionId, lifecycle } of rows) {
            signal.throwIfAborted();
            try {
                if (lifecycle === "deleting") {
                    await this.#cx.runtime.deleteSession(scope, sessionId, Date.now(), signal);
                } else {
                    await this.#cx.runtime.runArchiveWork(scope, sessionId, signal);
                    pending = this.#cx.runtime.hasPendingArchiveWork(scope, sessionId) || pending;
                }
                const outbound = await this.#cx.bots.listPendingOutbound(scope, sessionId, 100, Date.now(), signal);
                await this.reconcile(scope, sessionId, outbound, signal);
                pending = outbound.length > 0 || pending;
            } catch (error) {
                signal.throwIfAborted();
                console.error("Session archive recovery failed", error);
                pending = true;
            }
        }
        if (pending) {
            await this.#cx.schedule(Date.now() + 30_000, signal);
        }
    };

    readonly reconcile = async (
        scope: ProjectScope,
        sessionId: string,
        pending: readonly PendingBotOutbound[],
        signal: AbortSignal,
    ): Promise<void> => {
        for (const message of pending) {
            signal.throwIfAborted();
            try {
                const bindingId = this.#cx.runtime.readExecutionBinding(scope, sessionId, message.executionId);
                const tenant = await this.#cx.tenants.resolve(scope.tenantId, signal);
                const targets = this.#cx.services.forTenant(tenant).targets;
                const route = await targets.authorizeOutboundTarget(
                    message.botId,
                    bindingId,
                    message.deliveryTargetId,
                    signal,
                );
                await this.#cx.connections.enqueue(
                    route,
                    new BotOutboundAcceptance(
                        message.outboundMessageId,
                        message.botId,
                        message.conversationId,
                        message.turnId,
                        message.behaviorRevisionId,
                        message.bindingId,
                        message.bindingRevision,
                        message.executionId,
                        message.deliveryTargetId,
                        message.idempotencyKey,
                        message.text,
                        message.acceptedAt,
                        message.expiresAt,
                        false,
                    ),
                    signal,
                );
                await this.#cx.bots.markOutboundForwarded(
                    scope,
                    sessionId,
                    message.outboundMessageId,
                    Date.now(),
                    signal,
                );
            } catch (error) {
                signal.throwIfAborted();
                if (
                    error instanceof BotApiError &&
                    (error.code === "delivery_target_not_allowed" || error.code === "delivery_target_unavailable")
                ) {
                    await this.#cx.bots.markOutboundTerminalFailure(
                        scope,
                        sessionId,
                        message.outboundMessageId,
                        error.code,
                        Date.now(),
                        signal,
                    );
                    continue;
                }
                throw error;
            }
        }
    };
}
