import { setTimeout } from "node:timers/promises";
import { acquireManagerLock } from "../control/local-client.ts";
import { serveLocalControl } from "../control/local-server.ts";
import {
    type DaemonSwitchState,
    type LifecycleResponse,
    lifecycleCommand,
    type WorkerLaunch,
} from "../control/protocol.ts";
import { decodeWorkerLaunch, WorkerProcess, WorkerStartupError } from "./worker-process.ts";

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
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    };
    let switching: Promise<void> = Promise.resolve();
    // Serialize process mutations, but never hold the queue while waiting for health.
    // A starting worker must still be able to request an ordinary process switch.
    const waitForHealthyWorker = async (): Promise<void> => {
        while (worker !== undefined) {
            const current = worker;
            try {
                await current.ready;
            } catch (cause) {
                const superseded = await serialize(async () => {
                    if (worker !== current) {
                        return true;
                    }
                    await current.close();
                    return false;
                });
                if (superseded) {
                    continue;
                }
                throw cause;
            }
            if (await serialize(async () => worker === current)) {
                return;
            }
        }
    };
    const launchWorker = async (launch: WorkerLaunch): Promise<void> => {
        combined.throwIfAborted();
        await worker?.close();
        const replacement = new WorkerProcess(launch, combined, process.env);
        worker = replacement;
        void replacement.ready.then(
            async () => {
                await replacement.exited;
                try {
                    await setTimeout(1000, undefined, { signal: combined });
                    const restarted = await serialize(async () => {
                        if (worker !== replacement || combined.aborted) {
                            return false;
                        }
                        await launchWorker(replacement.launch);
                        return true;
                    });
                    if (restarted) {
                        await waitForHealthyWorker();
                    }
                } catch {
                    if (!combined.aborted) {
                        process.stderr.write("The working daemon could not be restarted; run mobius start to retry.\n");
                    }
                }
            },
            () => undefined,
        );
    };
    const start = async (launch: WorkerLaunch): Promise<void> => {
        await serialize(async () => launchWorker(launch));
        await waitForHealthyWorker();
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
                retryAfter: Date.now() + 8 * 3_600_000,
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
        if (command.kind === "ensure") {
            await serialize(async () => {
                requestSignal.throwIfAborted();
                const launch = await decodeWorkerLaunch(command.launch);
                if (!worker?.running || worker.launch.version !== launch.version) {
                    await launchWorker(launch);
                }
            });
            await waitForHealthyWorker();
            return status();
        }
        if (command.kind === "switch-status" && command.wait) {
            await switching;
        }
        return await serialize(async (): Promise<LifecycleResponse> => {
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
            }
        });
    };
    try {
        await serveLocalControl(stateDirectory, "manager", combined, handle, undefined, (response) => {
            if (
                typeof response === "object" &&
                response !== null &&
                "kind" in response &&
                response.kind === "switching"
            ) {
                const state = switchState;
                if (state?.kind !== "switching") {
                    return;
                }
                switching = switchWorker(state).catch(() => {
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
        await switching;
        await queue;
        await worker?.close();
        await release();
    }
}
