import type { AgentSession } from "./agent-session.ts";
import { AcpProcessCapacityLock, waitForAcpProcessCapacity } from "./process-capacity.ts";

const MAX_ACP_PROCESSES = 10;

export interface AgentProcessRetention {
    readonly isBusy: () => boolean;
    readonly retire: (runtime: AgentSession) => Promise<void>;
}

type ProcessSlot =
    | { readonly kind: "starting" }
    | { readonly kind: "retained"; readonly runtime: AgentSession; readonly retention: AgentProcessRetention }
    | { readonly kind: "transient" | "retiring"; readonly runtime: AgentSession };

/** Owns each capacity slot from reservation until the process has stopped. */
export class AgentProcessPool {
    readonly #slots = new Map<symbol, ProcessSlot>();
    readonly #lock = new AcpProcessCapacityLock();
    #changed = Promise.withResolvers<void>();

    readonly notifyChanged = (): void => {
        const changed = this.#changed;
        this.#changed = Promise.withResolvers<void>();
        changed.resolve();
    };

    readonly #find = (runtime: AgentSession): symbol | undefined => {
        for (const [id, slot] of this.#slots) {
            if (slot.kind !== "starting" && slot.runtime === runtime) {
                return id;
            }
        }
        return undefined;
    };

    readonly touch = (runtime: AgentSession): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            return;
        }
        const slot = this.#slots.get(id);
        if (slot?.kind !== "retained") {
            return;
        }
        this.#slots.delete(id);
        this.#slots.set(id, slot);
    };

    readonly retain = (runtime: AgentSession, retention: AgentProcessRetention): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            throw new Error("Cannot retain an unowned ACP process");
        }
        this.#slots.set(id, { kind: "retained", runtime, retention });
    };

    readonly releaseClosed = (runtime: AgentSession): void => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#slots.delete(id);
        }
        this.notifyChanged();
    };

    readonly retire = async (runtime: AgentSession, close: () => Promise<void>): Promise<void> => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#slots.set(id, { kind: "retiring", runtime });
        }
        try {
            await close();
        } finally {
            this.releaseClosed(runtime);
        }
    };

    readonly #reserve = async (signal: AbortSignal): Promise<symbol> => {
        const lease = await this.#lock.acquire(signal);
        try {
            for (;;) {
                signal.throwIfAborted();
                if (this.#slots.size < MAX_ACP_PROCESSES) {
                    const id = Symbol("ACP process slot");
                    this.#slots.set(id, { kind: "starting" });
                    return id;
                }
                const candidate = [...this.#slots.values()].find(
                    (slot) => slot.kind === "retained" && !slot.retention.isBusy(),
                );
                if (candidate?.kind === "retained") {
                    await candidate.retention.retire(candidate.runtime);
                    continue;
                }
                await waitForAcpProcessCapacity(this.#changed.promise, signal);
            }
        } finally {
            lease.release();
        }
    };

    readonly #start = async (
        signal: AbortSignal,
        start: () => Promise<AgentSession>,
        retention: AgentProcessRetention | null,
    ): Promise<AgentSession> => {
        const id = await this.#reserve(signal);
        try {
            const runtime = await start();
            this.#slots.set(
                id,
                retention === null ? { kind: "transient", runtime } : { kind: "retained", runtime, retention },
            );
            return runtime;
        } catch (error) {
            this.#slots.delete(id);
            throw error;
        } finally {
            this.notifyChanged();
        }
    };

    readonly startRetained = (
        signal: AbortSignal,
        start: () => Promise<AgentSession>,
        retention: AgentProcessRetention,
    ): Promise<AgentSession> => this.#start(signal, start, retention);

    readonly runTransient = async <T>(
        signal: AbortSignal,
        start: () => Promise<AgentSession>,
        operation: (runtime: AgentSession) => Promise<T>,
        close: (runtime: AgentSession) => Promise<void>,
    ): Promise<T> => {
        const runtime = await this.#start(signal, start, null);
        try {
            return await operation(runtime);
        } finally {
            await this.retire(runtime, () => close(runtime));
        }
    };
}
