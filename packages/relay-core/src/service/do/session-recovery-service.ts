import { BotApiError } from "../../entity/bot/bot-error.ts";
import { BotOutboundAcceptance, type PendingBotOutbound } from "../../entity/bot/bot-session.ts";
import type { ProjectScope } from "../../entity/do/session.ts";
import type { BotConnectionGateway } from "../../gateway/bot-connection-gateway.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type { BotTargetService } from "../bot/bot-target-service.ts";
import type { BotSessionService } from "./bot-session-service.ts";
import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

const ARCHIVE_CONTINUATION_DELAY_MILLISECONDS = 1_000;
const RECOVERY_RETRY_DELAY_MILLISECONDS = 30_000;
const STREAMING_ARCHIVE_DELAY_MILLISECONDS = 1_000;

interface SessionRecoveryContext {
    readonly runtime: SqliteSessionRuntime;
    readonly bots: BotSessionService;
    readonly services: {
        readonly forProject: (project: ProjectStorageContext) => { readonly targets: BotTargetService };
    };
    readonly projects: ProjectStorageDirectory;
    readonly connections: BotConnectionGateway;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}

export class SessionRecoveryService {
    readonly #cx: SessionRecoveryContext;
    #streamingArchiveScheduled = false;

    constructor(cx: SessionRecoveryContext) {
        this.#cx = cx;
    }

    readonly schedule = async (signal: AbortSignal): Promise<void> => {
        this.#streamingArchiveScheduled = false;
        await this.#cx.schedule(Date.now(), signal);
    };

    readonly deferStreamingArchive = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.#streamingArchiveScheduled) {
            return;
        }
        this.#streamingArchiveScheduled = true;
        try {
            await this.#cx.schedule(Date.now() + STREAMING_ARCHIVE_DELAY_MILLISECONDS, signal);
        } catch (error) {
            this.#streamingArchiveScheduled = false;
            throw error;
        }
    };

    readonly recover = async (signal: AbortSignal): Promise<void> => {
        this.#streamingArchiveScheduled = false;
        const rows = this.#cx.runtime.listRecoverySessions();
        let pending = false;
        let continueArchive = false;
        for (const { scope, sessionId, lifecycle } of rows) {
            signal.throwIfAborted();
            try {
                if (lifecycle === "deleting") {
                    await this.#cx.runtime.deleteSession(scope, sessionId, Date.now(), signal);
                } else {
                    const archived = await this.#cx.runtime.runArchiveWork(scope, sessionId, signal);
                    const archivePending = this.#cx.runtime.hasPendingArchiveWork(scope, sessionId);
                    continueArchive = (archivePending && archived > 0) || continueArchive;
                    pending = archivePending || pending;
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
            await this.#cx.schedule(
                Date.now() +
                    (continueArchive ? ARCHIVE_CONTINUATION_DELAY_MILLISECONDS : RECOVERY_RETRY_DELAY_MILLISECONDS),
                signal,
            );
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
                const project = await this.#cx.projects.resolve(scope.projectId, signal);
                if (project.projectId !== scope.projectId) {
                    throw new BotApiError("bot_service_unavailable", "The Project placement is invalid", "unavailable");
                }
                const targets = this.#cx.services.forProject(project).targets;
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
