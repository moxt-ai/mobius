export async function runDaemonEntrypoint(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const shutdown = new AbortController();
    const abort = (): void => shutdown.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
        await run(shutdown.signal);
    } catch (cause) {
        if (!shutdown.signal.aborted) {
            console.error("Mobius daemon failed", cause);
            process.exitCode = 1;
        }
    } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
    }
}
