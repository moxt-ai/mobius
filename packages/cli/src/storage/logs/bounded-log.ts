import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A local, bounded, newline-delimited log. When the file reaches its maximum
// size the oldest lines are dropped so the most recent history stays on disk.
//
// Construction never touches the filesystem: the directory is created lazily on
// the first record, and every record is best-effort. A log that cannot be
// written (missing directory permissions, a conflicting file, a full disk)
// reports the first failure through `onWriteFailure` and then stays silent —
// diagnostics must never block the lifecycle they observe.
export class BoundedLineLog {
    readonly #path: string;
    readonly #maximumBytes: number;
    readonly #directory: string;
    #reportedFailure = false;
    readonly #onWriteFailure: (cause: unknown) => void;

    constructor(
        directory: string,
        filename: string,
        maximumBytes: number,
        onWriteFailure: (cause: unknown) => void = () => undefined,
    ) {
        this.#directory = directory;
        this.#path = join(directory, filename);
        this.#maximumBytes = maximumBytes;
        this.#onWriteFailure = onWriteFailure;
    }

    readonly record = (line: string): void => {
        try {
            mkdirSync(this.#directory, { mode: 0o700, recursive: true });
            this.#append(line);
        } catch (cause) {
            if (!this.#reportedFailure) {
                this.#reportedFailure = true;
                this.#onWriteFailure(cause);
            }
        }
    };

    readonly #append = (line: string): void => {
        const encoded = `${line.replace(/[\r\n]+/gu, " ").trim()}\n`;
        const encodedBytes = Buffer.byteLength(encoded);
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
            .filter((candidate) => candidate.length > 0);
        let totalBytes = lines.reduce((total, candidate) => total + Buffer.byteLength(candidate) + 1, 0);
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
