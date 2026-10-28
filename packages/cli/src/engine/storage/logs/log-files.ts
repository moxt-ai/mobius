import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DAEMON_LOG_FILENAME = "daemon.log";
export const WORKER_LIFECYCLE_LOG_FILENAME = "worker-lifecycle.log";

export function unhandledRejectionLogFilename(role: "manager" | "worker"): string {
    return `unhandled-rejections-${role}.log`;
}

export function logDirectory(dataDirectory: string): string {
    return join(dataDirectory, "logs");
}

export function processLogPaths(dataDirectory: string): readonly string[] {
    return [
        WORKER_LIFECYCLE_LOG_FILENAME,
        unhandledRejectionLogFilename("manager"),
        unhandledRejectionLogFilename("worker"),
    ].map((filename) => join(logDirectory(dataDirectory), filename));
}

export function readLogText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}
