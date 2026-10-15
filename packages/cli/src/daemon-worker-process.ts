import { type ChildProcess, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerLaunch {
    readonly executable: string;
    readonly entry: string;
    readonly version: string;
}

export function currentWorkerLaunch(version: string): WorkerLaunch {
    return {
        executable: process.execPath,
        entry: fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url)),
        version,
    };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function decodeWorkerLaunch(value: unknown): Promise<WorkerLaunch> {
    if (
        !isRecord(value) ||
        typeof value["entry"] !== "string" ||
        typeof value["executable"] !== "string" ||
        typeof value["version"] !== "string" ||
        value["version"].length === 0 ||
        value["version"].length > 128
    ) {
        throw new Error("Invalid worker launch request");
    }
    const { entry, executable, version } = value;
    if (
        typeof entry !== "string" ||
        typeof executable !== "string" ||
        typeof version !== "string" ||
        !isAbsolute(entry) ||
        !isAbsolute(executable)
    ) {
        throw new Error("Worker launch paths must be absolute");
    }
    const resolvedEntry = await realpath(entry);
    const resolvedExecutable = await realpath(executable);
    if (!(await stat(resolvedEntry)).isFile() || !(await stat(resolvedExecutable)).isFile()) {
        throw new Error("Worker launch paths must be files");
    }
    return { entry: resolvedEntry, executable: resolvedExecutable, version };
}

export class WorkerProcess {
    readonly #child: ChildProcess;
    readonly #started = Promise.withResolvers<unknown>();
    readonly #closed = Promise.withResolvers<void>();
    readonly #pending = new Map<
        number,
        { readonly resolve: (value: unknown) => void; readonly reject: (cause: unknown) => void }
    >();
    #sequence = 0;
    readonly launch: WorkerLaunch;
    readonly ready: Promise<unknown>;

    constructor(launch: WorkerLaunch, signal: AbortSignal, environment: NodeJS.ProcessEnv) {
        signal.throwIfAborted();
        this.launch = launch;
        this.#child = spawn(launch.executable, [launch.entry, "__worker"], {
            env: environment,
            windowsHide: true,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        this.#child.on("message", (value: unknown) => {
            if (isRecord(value) && value["kind"] === "worker-ready") {
                if (value["version"] !== launch.version) {
                    this.#started.reject(new Error("The working daemon version does not match the requested version"));
                } else {
                    this.#started.resolve(value);
                }
                return;
            }
            if (!isRecord(value) || typeof value["id"] !== "number") {
                return;
            }
            this.#pending.get(value["id"])?.resolve(value["response"]);
        });
        this.#child.once("error", (cause) => {
            this.#rejectPending(cause);
            if (this.#child.pid === undefined) {
                this.#closed.resolve();
            }
        });
        this.#child.once("exit", () => {
            this.#rejectPending(new Error("The working daemon exited"));
            this.#closed.resolve();
        });
        this.ready = this.#waitForStart(signal);
    }

    get running(): boolean {
        return this.#child.exitCode === null && this.#child.signalCode === null && this.#child.connected;
    }

    readonly request = async (command: unknown, signal: AbortSignal): Promise<unknown> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(130_000)]);
        deadline.throwIfAborted();
        const id = ++this.#sequence;
        const result = Promise.withResolvers<unknown>();
        const abort = (): void => result.reject(deadline.reason);
        deadline.addEventListener("abort", abort, { once: true });
        this.#pending.set(id, result);
        try {
            this.#child.send({ id, command }, (error) => {
                if (error !== null) {
                    result.reject(error);
                }
            });
            return await result.promise;
        } finally {
            this.#pending.delete(id);
            deadline.removeEventListener("abort", abort);
        }
    };

    readonly close = async (): Promise<void> => {
        if (this.#child.connected) {
            this.#child.disconnect();
        }
        const timeout = setTimeout(() => this.#child.kill("SIGKILL"), 10_000);
        try {
            await this.#closed.promise;
        } finally {
            clearTimeout(timeout);
        }
    };

    async #waitForStart(signal: AbortSignal): Promise<unknown> {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        const abort = (): void => this.#started.reject(deadline.reason);
        deadline.addEventListener("abort", abort, { once: true });
        try {
            return await this.#started.promise;
        } finally {
            deadline.removeEventListener("abort", abort);
        }
    }

    #rejectPending(cause: unknown): void {
        this.#started.reject(cause);
        for (const pending of this.#pending.values()) {
            pending.reject(cause);
        }
    }
}
