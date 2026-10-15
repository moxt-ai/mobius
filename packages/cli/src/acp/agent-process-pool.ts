import type { AgentSession } from "./agent-session.ts";
import { AcpProcessCapacityLock, waitForAcpProcessCapacity } from "./process-capacity.ts";

const DEFAULT_MAX_ACP_PROCESSES = 1000;
// Retired Sessions stay resumable through their stored row, so the cap bounds
// live Agent processes only. Operators and tests may shrink it per daemon.
const MAX_ACP_PROCESSES_ENVIRONMENT_KEY = "MOBIUS_MAX_ACP_PROCESSES";

export function resolveMaxAcpProcesses(environment: Readonly<Record<string, string | undefined>>): number {
    const configured = environment[MAX_ACP_PROCESSES_ENVIRONMENT_KEY];
    if (configured === undefined || configured === "") {
        return DEFAULT_MAX_ACP_PROCESSES;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${MAX_ACP_PROCESSES_ENVIRONMENT_KEY} must be a positive integer`);
    }
    return parsed;
}

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
    readonly #maxProcesses: number;
    readonly #slots = new Map<symbol, ProcessSlot>();
    readonly #lock = new AcpProcessCapacityLock();
    #changed = Promise.withResolvers<void>();

    constructor(maxProcesses: number = DEFAULT_MAX_ACP_PROCESSES) {
        this.#maxProcesses = maxProcesses;
    }

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
                if (this.#slots.size < this.#maxProcesses) {
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
