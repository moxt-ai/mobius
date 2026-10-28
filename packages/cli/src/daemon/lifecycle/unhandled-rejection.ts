import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { logDirectory, unhandledRejectionLogFilename } from "../../engine/storage/logs/log-files.ts";

const MAXIMUM_REJECTION_LOG_BYTES = 512 * 1_024;
const MAXIMUM_REJECTION_TEXT_BYTES = 2_048;
const MAXIMUM_PENDING_REJECTIONS = 100;

export type DaemonProcessRole = "manager" | "worker";

// Diagnostic text only: names, messages, and codes. Local rejection payloads
// can carry user content, so keep the same single-line, bounded treatment as
// the other local lifecycle logs.
function describeRejection(reason: unknown): string {
    let described: string;
    if (reason instanceof Error) {
        const code = Reflect.get(reason, "code");
        const suffix = typeof code === "string" || typeof code === "number" ? ` (${String(code)})` : "";
        described = `${reason.name}${suffix}: ${reason.message}`;
    } else {
        described = String(reason);
    }
    const printable = Array.from(described, (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
    }).join("");
    return printable.slice(0, MAXIMUM_REJECTION_TEXT_BYTES);
}

export interface UnhandledRejectionGuard {
    // Rejections can fire before the daemon knows its control directory, so
    // entries are buffered until the first bind; stderr always carries them.
    readonly bindStateDirectory: (stateDirectory: InstallationDirectory) => void;
    readonly release: () => void;
}

// Node's default unhandled rejection mode kills the process, which would take
// the whole daemon down for a stray floating promise. While this guard is
// installed every unhandled rejection is recorded instead — stderr for the
// supervised worker's captured tail, a bounded local log beside the other
// daemon logs once its directory is bound. Recording is best-effort: a broken
// log must never become the failure that kills the daemon.
//
// Each role writes its own file: BoundedLineLog rotation is not safe across
// processes, so a file must have exactly one writer. The manager owns its file
// through manager.lock; the worker must bind only after acquiring worker.lock,
// which makes it the sole writer of its own file.
export function surviveUnhandledRejections(role: DaemonProcessRole): UnhandledRejectionGuard {
    let log: BoundedLineLog | null = null;
    const pending: string[] = [];
    const record = (reason: unknown): void => {
        try {
            const encoded = `Mobius daemon survived an unhandled rejection ${JSON.stringify({
                kind: "unhandled_rejection",
                pid: process.pid,
                reason: describeRejection(reason),
                timestamp: new Date().toISOString(),
            })}`;
            process.stderr.write(`${encoded}\n`);
            if (log === null) {
                if (pending.length < MAXIMUM_PENDING_REJECTIONS) {
                    pending.push(encoded);
                }
                return;
            }
            log.record(encoded);
        } catch {
            // The daemon must outlive the failure being diagnosed.
        }
    };
    process.on("unhandledRejection", record);
    return {
        bindStateDirectory: (stateDirectory: InstallationDirectory): void => {
            if (log !== null) {
                return;
            }
            log = new BoundedLineLog(
                logDirectory(stateDirectory),
                unhandledRejectionLogFilename(role),
                MAXIMUM_REJECTION_LOG_BYTES,
                (cause) => {
                    process.stderr.write(`The unhandled rejection log could not be written: ${String(cause)}\n`);
                },
            );
            for (const entry of pending.splice(0)) {
                log.record(entry);
            }
        },
        release: (): void => {
            process.off("unhandledRejection", record);
        },
    };
}
