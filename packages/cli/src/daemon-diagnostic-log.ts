import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAXIMUM_DAEMON_LOG_BYTES = 1 * 1_024 * 1_024;

export class DaemonDiagnosticLog {
    readonly #directory: string;
    readonly #path: string;
    readonly #maximumBytes: number;

    constructor(stateDirectory: string, maximumBytes: number = MAXIMUM_DAEMON_LOG_BYTES) {
        this.#directory = join(stateDirectory, "logs");
        this.#path = join(this.#directory, "daemon.log");
        this.#maximumBytes = maximumBytes;
    }

    readonly record = (diagnostic: string): void => {
        const encoded = `${diagnostic.replace(/[\r\n]+/gu, " ").trim()}\n`;
        const encodedBytes = Buffer.byteLength(encoded);
        mkdirSync(this.#directory, { mode: 0o700, recursive: true });
        let existingBytes = 0;
        try {
            existingBytes = statSync(this.#path).size;
        } catch (cause) {
            if (!(cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")) {
                throw cause;
            }
        }
        if (existingBytes + encodedBytes <= this.#maximumBytes) {
            appendFileSync(this.#path, encoded, { encoding: "utf8", mode: 0o600 });
            return;
        }

        const lines = `${existingBytes === 0 ? "" : readFileSync(this.#path, "utf8")}${encoded}`
            .split("\n")
            .filter((line) => line.length > 0);
        let totalBytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
        while (totalBytes > this.#maximumBytes && lines.length > 0) {
            const oldest = lines.shift();
            if (oldest !== undefined) {
                totalBytes -= Buffer.byteLength(oldest) + 1;
            }
        }
        const temporaryPath = `${this.#path}.tmp`;
        writeFileSync(temporaryPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        renameSync(temporaryPath, this.#path);
    };
}
