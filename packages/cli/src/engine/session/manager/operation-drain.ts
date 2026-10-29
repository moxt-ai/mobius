/** Owns in-flight Runtime requests until they release their Agent resources. */
export class RuntimeOperations {
    readonly #shutdown = new AbortController();
    readonly signal: AbortSignal = this.#shutdown.signal;
    readonly #pending = new Set<Promise<unknown>>();
    #closing: Promise<void> | null = null;

    readonly run = async <Options extends { readonly signal: AbortSignal }, Result>(
        options: Options,
        operation: (options: Options) => Promise<Result>,
        discard?: (result: Result) => Promise<void>,
    ): Promise<Result> => {
        const signal = AbortSignal.any([options.signal, this.#shutdown.signal]);
        signal.throwIfAborted();
        const pending = Promise.resolve().then(async () => {
            const result = await operation({ ...options, signal });
            if (signal.aborted) {
                // Acquired resources that cannot be handed to the caller must finish cleanup
                // before shutdown considers this operation drained.
                await discard?.(result);
                signal.throwIfAborted();
            }
            return result;
        });
        this.#pending.add(pending);
        try {
            return await pending;
        } finally {
            this.#pending.delete(pending);
        }
    };

    readonly close = (release: () => Promise<void>): Promise<void> => {
        if (this.#closing !== null) {
            return this.#closing;
        }
        this.#shutdown.abort();
        this.#closing = (async () => {
            await Promise.allSettled([...this.#pending]);
            await release();
        })();
        return this.#closing;
    };
}

/** A cancelled borrower stops waiting without cancelling a shared operation. */
export async function waitForSharedOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const abort = (): void => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([pending, cancelled.promise]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
