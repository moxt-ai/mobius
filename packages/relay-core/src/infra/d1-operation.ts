import { DatabaseError } from "./sql-database.ts";

export async function d1Operation<Value>(operation: () => Promise<Value>, signal: AbortSignal): Promise<Value> {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("The database operation timed out", "TimeoutError")),
        15_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let abort = (): void => {};
    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_resolve, reject) => {
                abort = () => reject(deadline.reason);
                deadline.addEventListener("abort", abort, { once: true });
                if (deadline.aborted) {
                    abort();
                }
            }),
        ]);
    } catch (cause) {
        signal.throwIfAborted();
        throw new DatabaseError(
            deadline.aborted ? "database_timeout" : "database_unavailable",
            "The database is unavailable",
            { cause },
        );
    } finally {
        clearTimeout(timer);
        deadline.removeEventListener("abort", abort);
    }
}
