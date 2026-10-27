import { setTimeout } from "node:timers/promises";
import { acquireManagerLock } from "../../storage/daemon/manager-lock.ts";
import type { InstallationDirectory } from "../../storage/installation/installation-files.ts";
import { serveLocalControl } from "../control/local-server.ts";
import {
    type DaemonReleaseSwitchState,
    type LifecycleResponse,
    lifecycleCommand,
    type WorkerLaunch,
} from "../control/protocol.ts";
import { discardRolledBackData } from "../upgrades/data.ts";
import { surviveUnhandledRejections } from "./unhandled-rejection.ts";
import { WorkerLifecycleLog } from "./worker-lifecycle-log.ts";
import { decodeWorkerLaunch, WorkerProcess, WorkerStartupError } from "./worker-process.ts";

export async function runManager(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const release = await acquireManagerLock(stateDirectory);
    if (release === null) {
        return;
    }
    const rejectionGuard = surviveUnhandledRejections("manager");
    rejectionGuard.bindStateDirectory(stateDirectory);
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const lifecycle = new WorkerLifecycleLog(stateDirectory);
    const workerExits = new Set<Promise<void>>();
    let worker: WorkerProcess | undefined;
    let switchState: DaemonReleaseSwitchState | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    const status = (): LifecycleResponse => ({
        kind: "status",
        protocolVersion: 2,
        worker: worker?.running ? { pid: worker.pid, version: worker.launch.version } : null,
    });
    const start = async (launch: WorkerLaunch): Promise<void> => {
        combined.throwIfAborted();
        await worker?.close();
        const replacement = new WorkerProcess(launch, combined, process.env);
        worker = replacement;
        // Reading pid throws only when spawn failed outright; ready is rejected
        // with worker_spawn_failed in that case, so consume it uniformly below.
        let pid: number | null = null;
        try {
            pid = replacement.pid;
        } catch {
            // The process never launched; there is no pid to record.
        }
        if (pid !== null) {
            lifecycle.started(pid, launch.version);
        }
        try {
            await replacement.ready;
        } catch (cause) {
            await replacement.close();
            await replacement.streamsSettled;
            const code = cause instanceof WorkerStartupError ? cause.code : "worker_start_failed";
            const message = cause instanceof WorkerStartupError ? cause.message : "The new daemon could not start";
            lifecycle.startFailed(launch.version, pid, code, message, replacement.stderr);
            throw cause;
        }
        if (pid !== null) {
            lifecycle.ready(pid, launch.version);
        }
        const exited = replacement.exited.then(async () => {
            // Wait for the stderr pipe to drain before freezing the tail into
            // the log; the restart below is not delayed by this.
            await replacement.streamsSettled;
            if (pid !== null) {
                lifecycle.exited(pid, launch.version, replacement.exit, replacement.stderr);
            }
            try {
                await setTimeout(1000, undefined, { signal: combined });
                const restart = queue.then(async () => {
                    if (worker === replacement && !combined.aborted) {
                        await start(replacement.launch);
                    }
                });
                queue = restart.catch(() => undefined);
                await restart;
            } catch {
                if (!combined.aborted) {
                    const message = "The working daemon could not be restarted; run mobius start to retry";
                    process.stderr.write(`${message}\n`);
                    lifecycle.restartFailed(launch.version, message);
                }
            }
        });
        workerExits.add(exited);
        void exited.finally(() => workerExits.delete(exited));
    };
    const switchWorker = async (
        transition: Extract<DaemonReleaseSwitchState, { kind: "switching" }>,
    ): Promise<void> => {
        try {
            await start(transition.next);
            switchState = { ...transition, kind: "switched" };
        } catch (cause) {
            combined.throwIfAborted();
            const code = cause instanceof WorkerStartupError ? cause.code : "worker_start_failed";
            const message = cause instanceof WorkerStartupError ? cause.message : "The new daemon could not start";
            // Keep the result in the surviving manager for the restored worker.
            switchState = {
                ...transition,
                kind: "rolled-back",
                code,
                message,
                stdout: cause instanceof WorkerStartupError ? cause.stdout : "",
                stderr: cause instanceof WorkerStartupError ? cause.stderr : "",
                retryAfter: Date.now() + 8 * 3_600_000,
            };
            await start(transition.previous);
            await discardRolledBackData(transition.next.version, combined);
        }
    };
    const handle = async (value: unknown, requestSignal: AbortSignal): Promise<LifecycleResponse> => {
        const parsed = lifecycleCommand.safeParse(value);
        if (!parsed.success) {
            return {
                kind: "error",
                code: "unsupported_lifecycle_command",
                message: "The manager only accepts lifecycle commands",
            };
        }
        const command = parsed.data;
        // The new worker needs its source version before it can announce readiness.
        if (command.kind === "switch-status" && !command.wait) {
            return { kind: "switch-status", state: switchState };
        }
        const result = queue.then(async (): Promise<LifecycleResponse> => {
            requestSignal.throwIfAborted();
            switch (command.kind) {
                case "switch-status":
                    return { kind: "switch-status", state: switchState };
                case "status":
                    return status();
                case "stop":
                    return { kind: "stopped" };
                case "switch": {
                    const state = switchState;
                    if (
                        state?.kind === "switching" ||
                        (state?.kind === "rolled-back" && state.retryAfter > Date.now())
                    ) {
                        return {
                            kind: "error",
                            code: "switch_blocked",
                            message: "A switch is in progress or cooling down",
                        };
                    }
                    if (!worker?.running) {
                        return {
                            kind: "error",
                            code: "worker_unavailable",
                            message: "There is no working daemon to replace",
                        };
                    }
                    const next = await decodeWorkerLaunch(command.launch);
                    if (next.version === worker.launch.version) {
                        return {
                            kind: "error",
                            code: "already_current",
                            message: "The requested version is already running",
                        };
                    }
                    switchState = {
                        kind: "switching",
                        id: command.id,
                        context: command.context,
                        previous: worker.launch,
                        next,
                    };
                    return { kind: "switching" };
                }
                case "ensure": {
                    const launch = await decodeWorkerLaunch(command.launch);
                    if (
                        !worker?.running ||
                        worker.launch.version !== launch.version ||
                        worker.launch.entry !== launch.entry ||
                        worker.launch.executable !== launch.executable
                    ) {
                        await start(launch);
                    }
                    await worker?.ready;
                    return status();
                }
            }
        });
        queue = result.catch(() => undefined);
        return await result;
    };
    try {
        await serveLocalControl(stateDirectory, "manager", combined, handle, undefined, (response) => {
            if (
                typeof response === "object" &&
                response !== null &&
                "kind" in response &&
                response.kind === "switching"
            ) {
                const pending = queue.then(async () => {
                    const state = switchState;
                    if (state?.kind === "switching") {
                        await switchWorker(state);
                    }
                });
                queue = pending.catch(() => {
                    if (!combined.aborted) {
                        process.stderr.write("Daemon switch or rollback failed; run mobius start to retry.\n");
                    }
                });
            }
            if (
                typeof response === "object" &&
                response !== null &&
                "kind" in response &&
                response.kind === "stopped"
            ) {
                shutdown.abort();
            }
        });
    } finally {
        shutdown.abort();
        await queue;
        await worker?.close();
        // Exit observers drain output and write the final lifecycle entry. Keep
        // ownership until they finish, before quit can report the manager gone.
        await Promise.all(workerExits);
        rejectionGuard.release();
        await release();
    }
}
