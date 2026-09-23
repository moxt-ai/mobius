import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

const RECOVERY_RETRY_DELAY_MILLISECONDS = 30_000;

interface SessionRecoveryContext {
    readonly runtime: SqliteSessionRuntime;
    readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
}

export class SessionRecoveryService {
    readonly #cx: SessionRecoveryContext;

    constructor(cx: SessionRecoveryContext) {
        this.#cx = cx;
    }

    readonly schedule = async (signal: AbortSignal): Promise<void> => {
        await this.#cx.schedule(Date.now(), signal);
    };

    readonly recover = async (signal: AbortSignal): Promise<void> => {
        const rows = this.#cx.runtime.listRecoverySessions();
        let pending = false;
        for (const { scope, sessionId, lifecycle } of rows) {
            signal.throwIfAborted();
            if (lifecycle !== "deleting") {
                continue;
            }
            try {
                await this.#cx.runtime.deleteSession(scope, sessionId, Date.now(), signal);
            } catch (error) {
                signal.throwIfAborted();
                console.error("Session deletion recovery failed", error);
                pending = true;
            }
        }
        if (pending) {
            await this.#cx.schedule(Date.now() + RECOVERY_RETRY_DELAY_MILLISECONDS, signal);
        }
    };
}
