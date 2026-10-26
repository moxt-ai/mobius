const maximumWaiters = 64;

/** Waiters are registered synchronously beside the empty durable read, before the route yields. */
export class RecordingEventWaiters {
    readonly #waiting = new Set<() => void>();

    readonly changed = (): void => {
        for (const wake of [...this.#waiting]) {
            wake();
        }
    };

    readonly wait = (milliseconds: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (this.#waiting.size >= maximumWaiters) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const cleanup = (): void => {
                clearTimeout(timeout);
                this.#waiting.delete(wake);
                signal.removeEventListener("abort", abort);
            };
            const wake = (): void => {
                cleanup();
                resolve();
            };
            const abort = (): void => {
                cleanup();
                reject(signal.reason);
            };
            const timeout = setTimeout(wake, milliseconds);
            this.#waiting.add(wake);
            signal.addEventListener("abort", abort, { once: true });
        });
    };
}
