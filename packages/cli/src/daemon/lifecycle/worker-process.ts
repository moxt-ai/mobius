import { type ChildProcess, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { type WorkerLaunch, workerLaunch } from "../control/protocol.ts";

export function currentWorkerLaunch(version: string): WorkerLaunch {
    const entry = process.argv[1];
    if (entry === undefined || entry.length === 0) {
        throw new Error("The Mobius CLI entry path is unavailable");
    }
    return {
        executable: process.execPath,
        entry: resolve(entry),
        version,
    };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function decodeWorkerLaunch(value: unknown): Promise<WorkerLaunch> {
    const { entry, executable, version } = workerLaunch.parse(value);
    if (!isAbsolute(entry) || !isAbsolute(executable)) {
        throw new Error("Worker launch paths must be absolute");
    }
    const resolvedEntry = await realpath(entry);
    const resolvedExecutable = await realpath(executable);
    if (!(await stat(resolvedEntry)).isFile() || !(await stat(resolvedExecutable)).isFile()) {
        throw new Error("Worker launch paths must be files");
    }
    return { entry: resolvedEntry, executable: resolvedExecutable, version };
}

export class WorkerStartupError extends Error {
    readonly code: string;
    readonly stdout: string;
    readonly stderr: string;
    constructor(code: string, message: string, options?: ErrorOptions, stdout = "", stderr = "") {
        super(message, options);
        this.code = code;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

export class WorkerProcess {
    readonly #child: ChildProcess;
    #stdout = "";
    #stderr = "";
    readonly #started = Promise.withResolvers<unknown>();
    readonly #closed = Promise.withResolvers<void>();
    readonly exited = this.#closed.promise;
    readonly launch: WorkerLaunch;
    readonly ready: Promise<unknown>;

    constructor(launch: WorkerLaunch, signal: AbortSignal, environment: NodeJS.ProcessEnv) {
        signal.throwIfAborted();
        this.launch = launch;
        this.#child = spawn(launch.executable, [launch.entry, "__worker"], {
            env: environment,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        this.#child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            this.#stdout = (this.#stdout + chunk).slice(-4096);
            process.stdout.write(chunk);
        });
        this.#child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            this.#stderr = (this.#stderr + chunk).slice(-4096);
            process.stderr.write(chunk);
        });
        this.#child.on("message", (value: unknown) => {
            if (isRecord(value) && value["kind"] === "worker-ready") {
                if (value["version"] !== launch.version) {
                    this.#started.reject(
                        new WorkerStartupError(
                            "worker_version_mismatch",
                            "The new daemon reported a different version",
                        ),
                    );
                } else {
                    this.#started.resolve(value);
                }
                return;
            }
        });
        this.#child.once("error", (cause) => {
            this.#started.reject(
                new WorkerStartupError("worker_spawn_failed", "The new daemon process could not be launched", {
                    cause,
                }),
            );
            if (this.#child.pid === undefined) {
                this.#closed.resolve();
            }
        });
        this.#child.once("exit", () => {
            this.#started.reject(
                new WorkerStartupError(
                    "worker_exited",
                    "The new daemon exited before becoming ready",
                    undefined,
                    this.#stdout,
                    this.#stderr,
                ),
            );
            this.#closed.resolve();
        });
        this.ready = this.#waitForStart(signal);
    }

    get running(): boolean {
        return this.#child.exitCode === null && this.#child.signalCode === null && this.#child.connected;
    }

    get pid(): number {
        const pid = this.#child.pid;
        if (pid === undefined) {
            throw new Error("The working process did not start");
        }
        return pid;
    }

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
        const abort = (): void =>
            this.#started.reject(
                signal.aborted
                    ? signal.reason
                    : new WorkerStartupError(
                          "worker_start_timeout",
                          "The new daemon did not become ready within 120 seconds",
                          { cause: deadline.reason },
                          this.#stdout,
                          this.#stderr,
                      ),
            );
        deadline.addEventListener("abort", abort, { once: true });
        try {
            return await this.#started.promise;
        } finally {
            deadline.removeEventListener("abort", abort);
        }
    }
}
