import type { ScheduledTask, Timer } from "../runtime/relay/timer.ts";
import type { AgentSession } from "./agent-session.ts";
import { AcpProcessCapacityLock, waitForAcpProcessCapacity } from "./process-capacity.ts";

const DEFAULT_MAX_ACP_PROCESSES = 1000;
const MAX_CONCURRENT_STARTS = 8;
// Retired Sessions stay resumable through their stored row, so the cap bounds
// live Agent processes only. Operators and tests may shrink it per daemon.
const MAX_ACP_PROCESSES_ENVIRONMENT_KEY = "MOBIUS_MAX_ACP_PROCESSES";
// A retained process that nothing touched for this long is closed; the next
// request resumes its Session in a new process. Operators and tests may
// shorten it per daemon.
const DEFAULT_ACP_PROCESS_IDLE_SECONDS = 24 * 60 * 60;
const ACP_PROCESS_IDLE_SECONDS_ENVIRONMENT_KEY = "MOBIUS_ACP_PROCESS_IDLE_SECONDS";
// Node fires longer timer delays after one millisecond instead.
const MAX_ACP_PROCESS_IDLE_SECONDS = Math.floor(2_147_483_647 / 1_000);

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

export function resolveAcpProcessIdleMilliseconds(environment: Readonly<Record<string, string | undefined>>): number {
    const configured = environment[ACP_PROCESS_IDLE_SECONDS_ENVIRONMENT_KEY];
    if (configured === undefined || configured === "") {
        return DEFAULT_ACP_PROCESS_IDLE_SECONDS * 1_000;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ACP_PROCESS_IDLE_SECONDS) {
        throw new Error(
            `${ACP_PROCESS_IDLE_SECONDS_ENVIRONMENT_KEY} must be an integer from 1 to ${MAX_ACP_PROCESS_IDLE_SECONDS.toString()}`,
        );
    }
    return parsed * 1_000;
}

export interface AgentProcessRetention {
    readonly isBusy: () => boolean;
    /** Stops the process to free capacity for another one. */
    readonly retire: (runtime: AgentSession) => Promise<void>;
    /** Stops the process after it stayed idle for the whole idle period. */
    readonly expire: (runtime: AgentSession) => Promise<void>;
}

type ProcessSlot =
    | { readonly kind: "starting" }
    | {
          readonly kind: "retained";
          readonly runtime: AgentSession;
          readonly retention: AgentProcessRetention;
          readonly idleExpiry: ScheduledTask;
      }
    | { readonly kind: "transient" | "retiring"; readonly runtime: AgentSession };

/** Owns each capacity slot from reservation until the process has stopped. */
export class AgentProcessPool {
    readonly #maxProcesses: number;
    readonly #idleMilliseconds: number;
    readonly #timer: Timer;
    readonly #slots = new Map<symbol, ProcessSlot>();
    readonly #expirations = new Set<Promise<void>>();
    readonly #lock = new AcpProcessCapacityLock();
    #starting = 0;
    #changed = Promise.withResolvers<void>();

    constructor(
        timer: Timer,
        maxProcesses: number = DEFAULT_MAX_ACP_PROCESSES,
        idleMilliseconds: number = DEFAULT_ACP_PROCESS_IDLE_SECONDS * 1_000,
    ) {
        this.#timer = timer;
        this.#maxProcesses = maxProcesses;
        this.#idleMilliseconds = idleMilliseconds;
    }

    readonly #retained = (id: symbol, runtime: AgentSession, retention: AgentProcessRetention): ProcessSlot => ({
        kind: "retained",
        runtime,
        retention,
        idleExpiry: this.#timer.schedule(() => this.#expire(id), this.#idleMilliseconds),
    });

    readonly #replace = (id: symbol, slot: ProcessSlot | null): void => {
        const current = this.#slots.get(id);
        if (current?.kind === "retained") {
            current.idleExpiry.cancel();
        }
        if (slot === null) {
            this.#slots.delete(id);
        } else {
            this.#slots.set(id, slot);
        }
    };

    readonly #expire = (id: symbol): void => {
        const slot = this.#slots.get(id);
        if (slot?.kind !== "retained") {
            return;
        }
        if (slot.retention.isBusy()) {
            // Work that outlasts the idle period starts a new one.
            this.#slots.set(id, this.#retained(id, slot.runtime, slot.retention));
            return;
        }
        const expiration = slot.retention.expire(slot.runtime).catch((error: unknown) => {
            console.error("Mobius daemon could not close an idle Agent process", error);
        });
        this.#expirations.add(expiration);
        void expiration.finally(() => {
            this.#expirations.delete(expiration);
        });
    };

    /**
     * An idle expiry starts outside any request, so shutdown has to wait for the processes it is still
     * stopping; they are already detached from their owners.
     */
    readonly settleExpirations = async (): Promise<void> => {
        await Promise.all(this.#expirations);
    };

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
        this.#replace(id, null);
        this.#slots.set(id, this.#retained(id, runtime, slot.retention));
    };

    readonly retain = (runtime: AgentSession, retention: AgentProcessRetention): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            throw new Error("Cannot retain an unowned ACP process");
        }
        this.#replace(id, this.#retained(id, runtime, retention));
    };

    readonly releaseClosed = (runtime: AgentSession): void => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#replace(id, null);
        }
        this.notifyChanged();
    };

    readonly retire = async (runtime: AgentSession, close: () => Promise<void>): Promise<void> => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#replace(id, { kind: "retiring", runtime });
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
                retention === null ? { kind: "transient", runtime } : this.#retained(id, runtime, retention),
            );
            return runtime;
        } catch (error) {
            this.#slots.delete(id);
            throw error;
        } finally {
            this.#starting -= 1;
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
