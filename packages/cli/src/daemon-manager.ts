import { setTimeout } from "node:timers/promises";
import { type LifecycleResponse, lifecycleCommand, type WorkerLaunch } from "./daemon-lifecycle-protocol.ts";
import { acquireManagerLock } from "./daemon-local-control.ts";
import { serveLocalControl } from "./daemon-local-server.ts";
import { decodeWorkerLaunch, WorkerProcess } from "./daemon-worker-process.ts";

export async function runManager(stateDirectory: string, signal: AbortSignal): Promise<void> {
    const release = await acquireManagerLock(stateDirectory);
    if (release === null) {
        return;
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    let worker: WorkerProcess | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    const status = (): LifecycleResponse => ({
        kind: "status",
        protocolVersion: 1,
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
        const result = queue.then(async (): Promise<LifecycleResponse> => {
            requestSignal.throwIfAborted();
            switch (command.kind) {
                case "status":
                    return status();
                case "stop":
                    return { kind: "stopped" };
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
