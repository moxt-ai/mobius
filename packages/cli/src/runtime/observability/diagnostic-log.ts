import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BoundedLineLog } from "../../storage/logs/bounded-log.ts";

const MAXIMUM_RUNTIME_LOG_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_ENTRIES = 200;
const MAXIMUM_REPORT_BYTES = 60_000;

// Correlation and failure metadata only. Every exported field is an identifier, a
// code, a name, or a bounded enum, so free text is deliberately absent: the
// process logs also carry a captured stderr and message tail that can quote Agent
// output, and that must stay local.
const REMOTE_DIAGNOSTIC_FIELDS = [
    "agentId",
    "operation",
    "runtimeId",
    "closeCode",
    "timeoutMilliseconds",
    "proxyRoute",
    "timestamp",
    "event",
    "channelId",
    "requestId",
    "commandId",
    "sessionId",
    "turnId",
    "connectionEpoch",
    "code",
    "source",
    "kind",
    "pid",
    "version",
    "exitCode",
    "signal",
    "failureName",
    "failureCode",
    "failureStatusCode",
    "cause1Name",
    "cause1Code",
    "cause2Name",
    "cause2Code",
] as const;

const FIELD_VALUE_PATTERN = /^[a-zA-Z0-9_.: -]{1,256}$/u;

/** The daemon process logs a Runtime does not own, but must read to explain its own deaths. */
const PROCESS_LOG_FILENAMES = [
    "worker-lifecycle.log",
    "unhandled-rejections-manager.log",
    "unhandled-rejections-worker.log",
] as const;

interface DiagnosticSource {
    readonly path: string;
    /** This log's own rotation bound, or null when another owner rotates it. */
    readonly maximumBytes: number | null;
}

export interface RuntimeDiagnosticLogOptions {
    readonly maximumBytes?: number;
    /**
     * Directory holding the manager-written process logs. The manager is the only
     * witness of how a worker died, so a bug report taken through a live Runtime
     * cannot explain a silent death without it. Read-only: rotation is unsafe
     * across processes, so each file keeps exactly one writer.
     */
    readonly processLogsDirectory?: string;
}

export class RuntimeDiagnosticLog {
    readonly #log: BoundedLineLog;
    readonly #maximumBytes: number;
    readonly #sources: readonly DiagnosticSource[];

    constructor(stateDirectory: string, options: RuntimeDiagnosticLogOptions = {}) {
        const maximumBytes = options.maximumBytes ?? MAXIMUM_RUNTIME_LOG_BYTES;
        const path = join(stateDirectory, "logs", "daemon.log");
        this.#log = new BoundedLineLog(join(stateDirectory, "logs"), "daemon.log", maximumBytes);
        this.#maximumBytes = maximumBytes;
        const processLogsDirectory = options.processLogsDirectory;
        this.#sources = [
            { maximumBytes, path },
            ...(processLogsDirectory === undefined
                ? []
                : PROCESS_LOG_FILENAMES.map((filename) => ({
                      maximumBytes: null,
                      path: join(processLogsDirectory, "logs", filename),
                  }))),
        ];
    }

    // Export only correlation and failure metadata. Local messages and paths stay local.
    readonly snapshot = (): {
        readonly entries: readonly Readonly<Record<string, string>>[];
        readonly truncated: boolean;
    } => {
        const merged: Record<string, string>[] = [];
        let truncated = false;
        for (const source of this.#sources) {
            const collected = this.#read(source);
            merged.push(...collected.entries);
            truncated ||= collected.truncated;
        }
        merged.sort(compareTimestamp);
        const entries = merged.slice(-MAXIMUM_ENTRIES);
        truncated ||= entries.length < merged.length;
        while (JSON.stringify(entries).length > MAXIMUM_REPORT_BYTES && entries.length > 0) {
            entries.shift();
            truncated = true;
        }
        return { entries, truncated };
    };

    readonly record = (diagnostic: string): void => {
        this.#log.record(diagnostic);
    };

    readonly #read = (
        source: DiagnosticSource,
    ): {
        readonly entries: Record<string, string>[];
        readonly truncated: boolean;
    } => {
        let content: string;
        try {
            content = readFileSync(source.path, "utf8");
        } catch {
            // Absent, mid-rotation, or owned by another process and unreadable:
            // a bug report degrades to the sources it can read.
            return { entries: [], truncated: false };
        }
        const lines = content.split("\n").filter((line) => line.length > 0);
        const entries: Record<string, string>[] = [];
        for (const line of lines.slice(-MAXIMUM_ENTRIES)) {
            const start = line.indexOf("{");
            if (start < 0) {
                continue;
            }
            let value: unknown;
            try {
                value = JSON.parse(line.slice(start));
            } catch {
                continue;
            }
            if (typeof value !== "object" || value === null) {
                continue;
            }
            entries.push(exportedFields(value));
        }
        const nearRotation = source.maximumBytes !== null && Buffer.byteLength(content) >= source.maximumBytes - 4096;
        return { entries, truncated: lines.length > MAXIMUM_ENTRIES || nearRotation };
    };
}

function exportedFields(value: object): Record<string, string> {
    const entry: Record<string, string> = {};
    for (const field of REMOTE_DIAGNOSTIC_FIELDS) {
        const item: unknown = Reflect.get(value, field);
        if (typeof item === "string" && FIELD_VALUE_PATTERN.test(item)) {
            entry[field] = item;
        } else if (typeof item === "number" && Number.isFinite(item)) {
            entry[field] = String(item);
        }
    }
    return entry;
}

function compareTimestamp(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): number {
    const leftAt = left["timestamp"] ?? "";
    const rightAt = right["timestamp"] ?? "";
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
}
