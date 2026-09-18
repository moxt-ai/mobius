import {
    decodeMessageKind,
    SESSION_COMPLETED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_FAILED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import { type CreateSessionBindingRequest, type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import type { SessionRecoveryService } from "./session-recovery-service.ts";
import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

interface DoServices {
    readonly runtime: SqliteSessionRuntime;
    readonly recovery: SessionRecoveryService;
}

function isTerminalSessionEvent(kind: string): boolean {
    return kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND;
}

function requiresDirectoryUpdate(kind: string): boolean {
    return (
        isTerminalSessionEvent(kind) ||
        kind === SESSION_STARTED_KIND ||
        kind === SESSION_CONFIG_UPDATED_KIND ||
        kind === SESSION_INFO_UPDATED_KIND
    );
}

export class DoService {
    readonly #services: DoServices;

    constructor(cx: { readonly services: DoServices }) {
        this.#services = cx.services;
    }

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
        const kind = decodeMessageKind(envelope.payload);
        if (isTerminalSessionEvent(kind)) {
            await this.#services.recovery.schedule(signal);
        } else {
            await this.#services.recovery.deferStreamingArchive(signal);
        }
        if (!requiresDirectoryUpdate(kind)) {
            return result;
        }
        const summary = await this.#services.runtime.readSession(scope, envelope.sessionId, signal);
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
