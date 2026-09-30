import type { RuntimeMessageSchedulerDepth } from "../../infra/recording-delivery-metrics.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PENDING_LIMIT = 512;

export class RuntimeMessageSchedulerCapacityError extends Error {
    readonly code = "runtime_message_queue_full";

    constructor(limit: number) {
        super(`Runtime message queue reached its limit of ${limit}`);
        this.name = "RuntimeMessageSchedulerCapacityError";
    }
}

class RuntimeMessageSlot {
    readonly #releaseSlot: () => void;
    #released = false;

    constructor(releaseSlot: () => void) {
        this.#releaseSlot = releaseSlot;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#releaseSlot();
    };
}

class RuntimeMessageSlotWaiter {
    readonly completion = Promise.withResolvers<RuntimeMessageSlot>();
    readonly signal: AbortSignal;

    constructor(signal: AbortSignal) {
        this.signal = signal;
    }

    readonly cancel = (): void => {
        this.completion.reject(this.signal.reason);
    };
}

class RuntimeMessageConcurrency {
    readonly #limit: number;
    #active = 0;
    readonly #waiters: RuntimeMessageSlotWaiter[] = [];

    constructor(limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Runtime message concurrency must be a positive safe integer");
        }
        this.#limit = limit;
    }

    readonly active = (): number => this.#active;

    readonly acquire = async (signal: AbortSignal): Promise<RuntimeMessageSlot> => {
        signal.throwIfAborted();
        if (this.#active < this.#limit) {
            this.#active += 1;
            return new RuntimeMessageSlot(this.#release);
        }

        const waiter = new RuntimeMessageSlotWaiter(signal);
        this.#waiters.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        try {
            return await waiter.completion.promise;
        } finally {
            signal.removeEventListener("abort", waiter.cancel);
            const waitingIndex = this.#waiters.indexOf(waiter);
            if (waitingIndex >= 0) {
                this.#waiters.splice(waitingIndex, 1);
            }
        }
    };

    readonly #release = (): void => {
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            if (waiter === undefined || waiter.signal.aborted) {
                continue;
            }
            waiter.completion.resolve(new RuntimeMessageSlot(this.#release));
            return;
        }
        this.#active -= 1;
    };
}

function waitForRuntimeMessage(completion: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const result = Promise.withResolvers<void>();
    const cancel = (): void => result.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void completion.then(
        () => {
            signal.removeEventListener("abort", cancel);
            result.resolve();
        },
        (error: unknown) => {
            signal.removeEventListener("abort", cancel);
            result.reject(error);
        },
    );
    return result.promise;
}

export class RuntimeMessageScheduler {
    readonly #concurrency: RuntimeMessageConcurrency;
    readonly #pendingLimit: number;
    readonly #lanes = new Map<string, Promise<void>>();
    readonly #operations = new Set<Promise<void>>();
    #pending = 0;

    constructor(concurrency = DEFAULT_CONCURRENCY, pendingLimit = DEFAULT_PENDING_LIMIT) {
        if (!Number.isSafeInteger(pendingLimit) || pendingLimit < concurrency) {
            throw new Error("Runtime message pending limit must cover the concurrency limit");
        }
        this.#concurrency = new RuntimeMessageConcurrency(concurrency);
        this.#pendingLimit = pendingLimit;
    }

    readonly run = async (lane: string, signal: AbortSignal, task: () => Promise<void>): Promise<void> => {
        signal.throwIfAborted();
        if (this.#pending >= this.#pendingLimit) {
            throw new RuntimeMessageSchedulerCapacityError(this.#pendingLimit);
        }
        this.#pending += 1;

        const previous = this.#lanes.get(lane) ?? Promise.resolve();
        const operation = (async (): Promise<void> => {
            await waitForRuntimeMessage(previous, signal);
            const slot = await this.#concurrency.acquire(signal);
            try {
                signal.throwIfAborted();
                await task();
            } finally {
                slot.release();
            }
        })();
        const tail = operation.catch(() => undefined);
        this.#lanes.set(lane, tail);
        this.#operations.add(tail);

        try {
            await operation;
        } finally {
            this.#pending -= 1;
            this.#operations.delete(tail);
            if (this.#lanes.get(lane) === tail) {
                this.#lanes.delete(lane);
            }
        }
    };

    /** Reports how much daemon message work this Runtime Relay is holding, which is the Relay-side backlog. */
    readonly depth = (): RuntimeMessageSchedulerDepth => ({
        active: this.#concurrency.active(),
        lanes: this.#lanes.size,
        pending: this.#pending,
    });

    readonly idle = async (signal: AbortSignal): Promise<void> => {
        while (this.#operations.size > 0) {
            await waitForRuntimeMessage(
                Promise.all(this.#operations).then(() => undefined),
                signal,
            );
        }
    };
}
