import { type ScheduledTask, systemTimer, type Timer } from "../../util/timer.ts";
import { AcpProcessCapacityLock, waitForAcpProcessCapacity } from "./process-capacity.ts";

const DEFAULT_MAX_ACP_PROCESSES = 1000;
const MAX_CONCURRENT_STARTS = 8;
const ACP_PROCESS_IDLE_TIMEOUT_MILLISECONDS = 2 * 60 * 60 * 1_000;
/** Identity of a reserved runtime; its owner supplies the actual teardown operation. */
export type AgentProcess = object;

export interface AgentProcessRetention<P extends AgentProcess> {
    readonly isBusy: () => boolean;
    readonly retire: (runtime: P) => Promise<void>;
    readonly retireIdle: (runtime: P) => Promise<void>;
}

interface RetainedProcessPolicy {
    readonly isBusy: () => boolean;
    readonly retire: () => Promise<void>;
    readonly retireIdle: () => Promise<void>;
}

type ProcessSlot =
    | { readonly kind: "starting" }
    | { readonly kind: "retained"; readonly runtime: AgentProcess; readonly retention: RetainedProcessPolicy }
    | { readonly kind: "transient" | "retiring"; readonly runtime: AgentProcess };

/** Owns each capacity slot from reservation until the process has stopped. */
export class AgentProcessPool {
    readonly #maxProcesses: number;
    readonly #timer: Timer;
    readonly #slots = new Map<symbol, ProcessSlot>();
    readonly #idleTimeouts = new Map<symbol, ScheduledTask>();
    readonly #idleRetirements = new Set<Promise<void>>();
    readonly #lock = new AcpProcessCapacityLock();
    #stopping = false;
    #starting = 0;
    #changed = Promise.withResolvers<void>();

    constructor(maxProcesses: number = DEFAULT_MAX_ACP_PROCESSES, timer: Timer = systemTimer) {
        this.#maxProcesses = maxProcesses;
        this.#timer = timer;
    }

    readonly notifyChanged = (): void => {
        for (const [id, slot] of this.#slots) {
            this.#updateIdleTimeout(id, slot);
        }
        const changed = this.#changed;
        this.#changed = Promise.withResolvers<void>();
        changed.resolve();
    };

    readonly #cancelIdleTimeout = (id: symbol): void => {
        this.#idleTimeouts.get(id)?.cancel();
        this.#idleTimeouts.delete(id);
    };

    readonly #updateIdleTimeout = (id: symbol, slot: ProcessSlot): void => {
        if (this.#stopping || slot.kind !== "retained" || slot.retention.isBusy()) {
            this.#cancelIdleTimeout(id);
            return;
        }
        if (this.#idleTimeouts.has(id)) {
            return;
        }
        const timeout = this.#timer.schedule(() => {
            if (this.#idleTimeouts.get(id) !== timeout) {
                return;
            }
            this.#idleTimeouts.delete(id);
            // Recheck ownership and activity at the deadline. Retirement detaches the process
            // synchronously before awaiting teardown, so a new request starts a fresh process.
            if (this.#stopping || this.#slots.get(id) !== slot || slot.retention.isBusy()) {
                return;
            }
            const retirement = slot.retention.retireIdle();
            this.#idleRetirements.add(retirement);
            void retirement
                .catch((error: unknown) => console.error("The idle Agent process could not be released", error))
                .finally(() => this.#idleRetirements.delete(retirement));
        }, ACP_PROCESS_IDLE_TIMEOUT_MILLISECONDS);
        this.#idleTimeouts.set(id, timeout);
    };

    /** Stop scheduling before Runtime shutdown and drain teardowns already in flight. */
    readonly stopIdleReclamation = async (): Promise<void> => {
        this.#stopping = true;
        for (const id of this.#idleTimeouts.keys()) {
            this.#cancelIdleTimeout(id);
        }
        await Promise.allSettled([...this.#idleRetirements]);
    };

    readonly #find = (runtime: AgentProcess): symbol | undefined => {
        for (const [id, slot] of this.#slots) {
            if (slot.kind !== "starting" && slot.runtime === runtime) {
                return id;
            }
        }
        return undefined;
    };

    readonly touch = (runtime: AgentProcess): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            return;
        }
        const slot = this.#slots.get(id);
        if (slot?.kind !== "retained") {
            return;
        }
        this.#cancelIdleTimeout(id);
        this.#slots.delete(id);
        this.#slots.set(id, slot);
        this.#updateIdleTimeout(id, slot);
    };

    readonly retain = <P extends AgentProcess>(runtime: P, retention: AgentProcessRetention<P>): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            throw new Error("Cannot retain an unowned ACP process");
        }
        this.#cancelIdleTimeout(id);
        const slot = {
            kind: "retained",
            runtime,
            retention: {
                isBusy: retention.isBusy,
                retire: () => retention.retire(runtime),
                retireIdle: () => retention.retireIdle(runtime),
            },
        } satisfies ProcessSlot;
        this.#slots.set(id, slot);
        this.#updateIdleTimeout(id, slot);
    };

    readonly releaseClosed = (runtime: AgentProcess): void => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#cancelIdleTimeout(id);
            this.#slots.delete(id);
        }
        this.notifyChanged();
    };

    readonly retire = async (runtime: AgentProcess, close: () => Promise<void>): Promise<void> => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#cancelIdleTimeout(id);
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
                if (this.#starting >= MAX_CONCURRENT_STARTS) {
                    await waitForAcpProcessCapacity(this.#changed.promise, signal);
                    continue;
                }
                if (this.#slots.size < this.#maxProcesses) {
                    const id = Symbol("ACP process slot");
                    this.#slots.set(id, { kind: "starting" });
                    this.#starting += 1;
                    return id;
                }
                const candidate = [...this.#slots.values()].find(
                    (slot) => slot.kind === "retained" && !slot.retention.isBusy(),
                );
                if (candidate?.kind === "retained") {
                    await candidate.retention.retire();
                    continue;
                }
                await waitForAcpProcessCapacity(this.#changed.promise, signal);
            }
        } finally {
            lease.release();
        }
    };

    readonly #start = async <P extends AgentProcess>(
        signal: AbortSignal,
        start: () => Promise<P>,
        retention: AgentProcessRetention<P> | null,
    ): Promise<P> => {
        const id = await this.#reserve(signal);
        try {
            const runtime = await start();
            this.#slots.set(id, { kind: "transient", runtime });
            if (retention !== null) {
                this.retain(runtime, retention);
            }
            return runtime;
        } catch (error) {
            this.#slots.delete(id);
            throw error;
        } finally {
            this.#starting -= 1;
            this.notifyChanged();
        }
    };

    readonly startRetained = <P extends AgentProcess>(
        signal: AbortSignal,
        start: () => Promise<P>,
        retention: AgentProcessRetention<P>,
    ): Promise<P> => this.#start(signal, start, retention);

    readonly runTransient = async <P extends AgentProcess, T>(
        signal: AbortSignal,
        start: () => Promise<P>,
        operation: (runtime: P) => Promise<T>,
        close: (runtime: P) => Promise<void>,
    ): Promise<T> => {
        const runtime = await this.#start(signal, start, null);
        try {
            return await operation(runtime);
        } finally {
            await this.retire(runtime, () => close(runtime));
        }
    };
}
