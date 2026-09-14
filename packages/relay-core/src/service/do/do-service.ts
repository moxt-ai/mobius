import {
    decodeMessageKind,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import type { BotOutboundSubmission } from "../../entity/bot/bot-session.ts";
import { type CreateSessionBindingRequest, type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import type { BotSessionService } from "./bot-session-service.ts";
import type { SessionRecoveryService } from "./session-recovery-service.ts";
import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

interface DoServices {
    readonly runtime: SqliteSessionRuntime;
    readonly bots: BotSessionService;
    readonly recovery: SessionRecoveryService;
}

export class DoService {
    readonly #services: DoServices;

    constructor(cx: { readonly services: DoServices }) {
        this.#services = cx.services;
    }

    readonly acceptOutbound = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        submission: BotOutboundSubmission,
        now: number,
        signal: AbortSignal,
    ) => {
        const accepted = await this.#services.bots.acceptOutbound(
            scope,
            sessionId,
            executionId,
            capabilitySecret,
            submission,
            now,
            signal,
        );
        await this.#services.recovery.schedule(signal);
        return accepted;
    };

    readonly commitEvent = async (
        scope: ProjectScope,
        runtimeId: string,
        envelope: SessionEventEnvelope,
        now: number,
        signal: AbortSignal,
    ) => {
        let result: Awaited<ReturnType<SqliteSessionRuntime["commitEvent"]>>;
        try {
            result = await this.#services.runtime.commitEvent(scope, runtimeId, envelope, now, signal);
        } catch (error) {
            if (!signal.aborted && error instanceof SessionRuntimeError && error.code === "session_busy") {
                await this.#services.recovery.schedule(signal);
            }
            throw error;
        }
        if (!result.duplicate) {
            const kind = decodeMessageKind(envelope.payload);
            if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
                const payload: unknown = JSON.parse(envelope.payload);
                const record =
                    typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
                const commandId = "commandId" in record && typeof record.commandId === "string" ? record.commandId : "";
                const outcome =
                    kind === SESSION_FAILED_KIND
                        ? "failed"
                        : "stopReason" in record && record.stopReason === "cancelled"
                          ? "cancelled"
                          : "completed";
                const pending = await this.#services.bots.settleExecution(
                    scope,
                    envelope.sessionId,
                    commandId,
                    outcome,
                    now,
                    signal,
                );
                await this.#services.recovery.reconcile(scope, envelope.sessionId, pending, signal);
            }
        }
        const summary = await this.#services.runtime.readSession(scope, envelope.sessionId, signal);
        await this.#services.recovery.schedule(signal);
        return { ...result, summary };
    };

    readonly importSession = async (
        scope: ProjectScope,
        exported: unknown,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => {
        const summary = await this.#services.runtime.importSession(scope, exported, binding, now, signal);
        await this.#services.recovery.schedule(signal);
        return summary;
    };

    readonly recoverFromFailure = async (error: unknown, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (error instanceof SessionRuntimeError && error.code === "session_deleted") {
            await this.#services.recovery.schedule(signal);
        }
    };
}
