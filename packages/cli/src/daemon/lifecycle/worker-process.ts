import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { resolveLaunchFiles } from "../../engine/util/process/local-executable.ts";
import { isRecord } from "../../engine/util/value-utils.ts";
import { type WorkerLaunch, workerLaunch } from "../control/protocol.ts";

export async function decodeWorkerLaunch(value: unknown): Promise<WorkerLaunch> {
    const { entry, executable, version } = workerLaunch.parse(value);
    if (!isAbsolute(entry) || !isAbsolute(executable)) {
        throw new Error("Worker launch paths must be absolute");
    }
    const resolved = await resolveLaunchFiles(entry, executable);
    if (resolved === null) {
        throw new Error("Worker launch paths must be files");
    }
    return { entry: resolved.entry, executable: resolved.executable, version };
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

// How a worker process terminated: `exitCode` for a normal exit, `signal` for a
// termination by signal (SIGKILL, SIGHUP, OOM-killer), both null when the
// process never launched.
export interface WorkerExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
}

export class WorkerProcess {
    readonly #child: ChildProcess;
    #stdout = "";
    #stderr = "";
    readonly #started = Promise.withResolvers<unknown>();
    readonly #closed = Promise.withResolvers<void>();
    readonly #drained = Promise.withResolvers<void>();
    #exit: WorkerExit | null = null;
    readonly exited = this.#closed.promise;
    // Resolves once the child's stdio streams are closed, so the captured stderr
    // tail is final. Bounded: if an orphaned grandchild inherits the pipes and
    // keeps them open, the fallback timer still resolves it.
    readonly streamsSettled: Promise<void> = this.#drained.promise;
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
        this.#child.once("close", () => {
            this.#drained.resolve();
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
                this.#exit = { code: null, signal: null };
                this.#boundStreamsSettled();
                this.#closed.resolve();
            }
        });
        this.#child.once("exit", (code, signal) => {
            this.#exit = { code, signal };
            this.#boundStreamsSettled();
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

    #boundStreamsSettled(): void {
        const giveUp = setTimeout(() => this.#drained.resolve(), 2_000);
        void this.#drained.promise.then(() => clearTimeout(giveUp));
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

    // How the child terminated, available once `exited` settles. `code` and `signal`
    // are null when the process could not be launched at all.
    get exit(): WorkerExit {
        if (this.#exit === null) {
            throw new Error("The working process has not exited");
        }
        return this.#exit;
    }

    get stderr(): string {
        return this.#stderr;
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
        if (deadline.aborted) {
            abort();
        }
        try {
            return await this.#started.promise;
        } finally {
            deadline.removeEventListener("abort", abort);
        }
    }
}
