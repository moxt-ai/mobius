import type { SqliteSessionRuntime } from "./sqlite-session-runtime.ts";

const ARCHIVE_CONTINUATION_DELAY_MILLISECONDS = 1_000;
const RECOVERY_RETRY_DELAY_MILLISECONDS = 30_000;
const STREAMING_ARCHIVE_DELAY_MILLISECONDS = 1_000;

interface SessionRecoveryContext {
    readonly runtime: SqliteSessionRuntime;
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
}
