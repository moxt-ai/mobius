import { AcpProcessCapacityLock, waitForAcpProcessCapacity } from "./process-capacity.ts";
import type { AcpProcessSession } from "./process-session.ts";

const MAX_ACP_PROCESSES = 10;

export interface AcpProcessRetention {
    readonly isBusy: () => boolean;
    readonly retire: (runtime: AcpProcessSession) => Promise<void>;
}

type ProcessSlot =
    | { readonly kind: "starting" }
    | { readonly kind: "retained"; readonly runtime: AcpProcessSession; readonly retention: AcpProcessRetention }
    | { readonly kind: "transient" | "retiring"; readonly runtime: AcpProcessSession };

/** Owns each capacity slot from reservation until the process has stopped. */
export class AcpProcessPool {
    readonly #slots = new Map<symbol, ProcessSlot>();
    readonly #lock = new AcpProcessCapacityLock();
    #changed = Promise.withResolvers<void>();

    readonly notifyChanged = (): void => {
        const changed = this.#changed;
        this.#changed = Promise.withResolvers<void>();
        changed.resolve();
    };

    readonly #find = (runtime: AcpProcessSession): symbol | undefined => {
        for (const [id, slot] of this.#slots) {
            if (slot.kind !== "starting" && slot.runtime === runtime) {
                return id;
            }
        }
        return undefined;
    };

    readonly touch = (runtime: AcpProcessSession): void => {
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

    readonly retain = (runtime: AcpProcessSession, retention: AcpProcessRetention): void => {
        const id = this.#find(runtime);
        if (id === undefined) {
            throw new Error("Cannot retain an unowned ACP process");
        }
        this.#slots.set(id, { kind: "retained", runtime, retention });
    };

    readonly releaseClosed = (runtime: AcpProcessSession): void => {
        const id = this.#find(runtime);
        if (id !== undefined) {
            this.#slots.delete(id);
        }
        this.notifyChanged();
    };

    readonly retire = async (runtime: AcpProcessSession, close: () => Promise<void>): Promise<void> => {
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
        start: () => Promise<AcpProcessSession>,
        retention: AcpProcessRetention | null,
    ): Promise<AcpProcessSession> => {
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
        start: () => Promise<AcpProcessSession>,
        retention: AcpProcessRetention,
    ): Promise<AcpProcessSession> => this.#start(signal, start, retention);

    readonly runTransient = async <T>(
        signal: AbortSignal,
        start: () => Promise<AcpProcessSession>,
        operation: (runtime: AcpProcessSession) => Promise<T>,
        close: (runtime: AcpProcessSession) => Promise<void>,
    ): Promise<T> => {
        const runtime = await this.#start(signal, start, null);
        try {
            return await operation(runtime);
        } finally {
            await this.retire(runtime, () => close(runtime));
        }
    };
}
