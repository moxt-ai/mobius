import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";

export async function waitForD1<Value>(operation: () => Promise<Value>, signal: AbortSignal): Promise<Value> {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let abort = (): void => {};
    try {
        const value = await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                abort = () => reject(deadline.reason);
                deadline.addEventListener("abort", abort, { once: true });
                if (deadline.aborted) {
                    abort();
                }
            }),
        ]);
        deadline.throwIfAborted();
        return value;
    } catch (cause) {
        signal.throwIfAborted();
        throw new DatabaseError(
            timeout.signal.aborted ? "database_timeout" : "database_unavailable",
            "Platform storage is unavailable",
            { cause },
        );
    } finally {
        clearTimeout(timer);
        deadline.removeEventListener("abort", abort);
    }
}
