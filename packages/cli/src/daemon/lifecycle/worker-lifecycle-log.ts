import type { InstallationDirectory } from "../../storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../storage/logs/bounded-log.ts";
import { logDirectory, WORKER_LIFECYCLE_LOG_FILENAME } from "../../storage/logs/log-files.ts";

const MAXIMUM_LIFECYCLE_LOG_BYTES = 512 * 1_024;
const MAXIMUM_TEXT_BYTES = 2_048;

function toLogText(value: string): string {
    // Keep each entry on one line even when the captured text contains newlines,
    // and keep the END of the text: the fatal error is at the tail, so a prefix
    // cut would preserve noise and drop the cause of death.
    const singleLine = Array.from(value, (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
    }).join("");
    return singleLine.slice(-MAXIMUM_TEXT_BYTES);
}

// The manager is the only process that outlives every worker, so it is the only
// witness of how a worker died. This local log records each worker start,
// readiness, and death (exit code or killing signal, with the captured stderr
// tail) at a version-stable path, so a silent death like SIGHUP or an
// out-of-memory kill can be attributed after the fact.
//
// The log is diagnostic only: construction and writes are best-effort and never
// throw, so a broken log can never block the lifecycle it observes.
export class WorkerLifecycleLog {
    readonly #log: BoundedLineLog;

    constructor(stateDirectory: InstallationDirectory) {
        this.#log = new BoundedLineLog(
            logDirectory(stateDirectory),
            WORKER_LIFECYCLE_LOG_FILENAME,
            MAXIMUM_LIFECYCLE_LOG_BYTES,
            (cause) => {
                process.stderr.write(`The worker lifecycle log could not be written: ${String(cause)}\n`);
            },
        );
    }

    readonly started = (pid: number, version: string): void => {
        this.#append({ kind: "worker_started", pid, version });
    };

    readonly ready = (pid: number, version: string): void => {
        this.#append({ kind: "worker_ready", pid, version });
    };

    readonly exited = (
        pid: number,
        version: string,
        exit: { readonly code: number | null; readonly signal: string | null },
        stderr: string,
    ): void => {
        this.#append({
            kind: "worker_exited",
            pid,
            version,
            exitCode: exit.code,
            signal: exit.signal,
            stderr: toLogText(stderr),
        });
    };

    readonly startFailed = (
        version: string,
        pid: number | null,
        code: string,
        message: string,
        stderr: string,
    ): void => {
        this.#append({
            kind: "worker_start_failed",
            pid,
            version,
            code,
            message: toLogText(message),
            stderr: toLogText(stderr),
        });
    };

    readonly restartFailed = (version: string, message: string): void => {
        this.#append({ kind: "worker_restart_failed", version, message: toLogText(message) });
    };

    readonly #append = (entry: Readonly<Record<string, unknown>>): void => {
        this.#log.record(
            `Mobius worker lifecycle ${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}`,
        );
    };
}
