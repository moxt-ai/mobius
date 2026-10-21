import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BoundedLineLog } from "./bounded-log.ts";

const MAXIMUM_RUNTIME_LOG_BYTES = 1 * 1_024 * 1_024;

export class RuntimeDiagnosticLog {
    readonly #path: string;
    readonly #log: BoundedLineLog;
    readonly #maximumBytes: number;

    constructor(stateDirectory: string, maximumBytes: number = MAXIMUM_RUNTIME_LOG_BYTES) {
        this.#path = join(stateDirectory, "logs", "daemon.log");
        this.#log = new BoundedLineLog(join(stateDirectory, "logs"), "daemon.log", maximumBytes);
        this.#maximumBytes = maximumBytes;
    }

    // Export only correlation and failure metadata. Local messages and paths stay local.
    readonly snapshot = (): {
        readonly entries: readonly Readonly<Record<string, string>>[];
        readonly truncated: boolean;
    } => {
        let content: string;
        try {
            content = readFileSync(this.#path, "utf8");
        } catch (cause) {
            if (cause instanceof Error && Reflect.get(cause, "code") === "ENOENT") {
                return { entries: [], truncated: false };
            }
            throw cause;
        }
        const lines = content.split("\n").filter((line) => line.length > 0);
        const entries: Readonly<Record<string, string>>[] = [];
        const fields = [
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
            "failureName",
            "failureCode",
            "failureStatusCode",
            "cause1Name",
            "cause1Code",
            "cause2Name",
            "cause2Code",
        ];
        for (const line of lines.slice(-200)) {
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
            const entry: Record<string, string> = {};
            for (const field of fields) {
                const item: unknown = Reflect.get(value, field);
                if (typeof item === "string" && /^[a-zA-Z0-9_.: -]{1,256}$/u.test(item)) {
                    entry[field] = item;
                }
            }
            entries.push(entry);
        }
        let truncated = lines.length > 200 || Buffer.byteLength(content) >= this.#maximumBytes - 4096;
        while (JSON.stringify(entries).length > 60_000) {
            entries.shift();
            truncated = true;
        }
        return { entries, truncated };
    };

    readonly record = (diagnostic: string): void => {
        this.#log.record(diagnostic);
    };
}
