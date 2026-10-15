import { setTimeout } from "node:timers/promises";
import {
    type DaemonSwitchState,
    type LifecycleResponse,
    lifecycleCommand,
    type WorkerLaunch,
} from "./daemon-lifecycle-protocol.ts";
import { acquireManagerLock } from "./daemon-local-control.ts";
import { serveLocalControl } from "./daemon-local-server.ts";
import { decodeWorkerLaunch, WorkerProcess, WorkerStartupError } from "./daemon-worker-process.ts";

export async function runManager(stateDirectory: string, signal: AbortSignal): Promise<void> {
    const release = await acquireManagerLock(stateDirectory);
    if (release === null) {
        return;
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    let worker: WorkerProcess | undefined;
    let switchState: DaemonSwitchState | null = null;
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
        try {
            await replacement.ready;
        } catch (cause) {
            await replacement.close();
            throw cause;
        }
        void replacement.exited.then(async () => {
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
                    process.stderr.write("The working daemon could not be restarted; run mobius start to retry.\n");
                }
            }
        });
    };
    const switchWorker = async (transition: Extract<DaemonSwitchState, { kind: "switching" }>): Promise<void> => {
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
                retryAfter: Date.now() + 3_600_000,
            };
            await start(transition.previous);
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
                    if (!worker?.running || worker.launch.version !== launch.version) {
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
        await release();
    }
}
