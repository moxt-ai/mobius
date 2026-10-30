import packageMetadata from "../../../package.json" with { type: "json" };
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { logDirectory, WORKER_LIFECYCLE_LOG_FILENAME } from "../../engine/storage/logs/log-files.ts";
import { runWorker } from "./worker.ts";

// Retain the old internal entrypoint for existing launchers; there is only one daemon process.
export async function runManager(directory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    try {
        await runWorker(packageMetadata.version, signal);
    } catch (cause) {
        new BoundedLineLog(logDirectory(directory), WORKER_LIFECYCLE_LOG_FILENAME, 512 * 1024).record(
            JSON.stringify({
                kind: "daemon_failed",
                message: cause instanceof Error ? cause.message : "Daemon failed",
            }),
        );
        throw cause;
    }
}
