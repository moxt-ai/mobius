import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { acquireManagerLock } from "./daemon-local-control.ts";
import { serveLocalControl } from "./daemon-local-server.ts";
import { RuntimeSupervisor } from "./daemon-runtime-supervisor.ts";
import { type WorkerResponse, workerCommand } from "./daemon-worker-protocol.ts";
import { openMobiusCliInstallation } from "./pairing/pair-local-machine.ts";

const requestSchema = z.object({ version: z.string(), command: workerCommand });

export async function runWorker(version: string, signal: AbortSignal): Promise<void> {
    if (!process.connected) {
        throw new Error("The working daemon must be started by its manager");
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const disconnected = (): void => shutdown.abort();
    process.once("disconnect", disconnected);
    const installation = await openMobiusCliInstallation(combined, process.env);
    const release = await acquireWorkerLock(installation.stateDirectory, combined);
    const supervisor = new RuntimeSupervisor(installation);
    const handle = async (value: unknown, requestSignal: AbortSignal): Promise<WorkerResponse> => {
        const parsed = requestSchema.safeParse(value);
        if (!parsed.success) {
            return { kind: "error", code: "invalid_worker_command", message: "Invalid daemon command" };
        }
        if (parsed.data.version !== version) {
            return {
                kind: "error",
                code: "worker_version_changed",
                message: "The working daemon version changed; retry the command",
            };
        }
        const command = parsed.data.command;
        switch (command.kind) {
            case "list":
                return { kind: "listed", pairs: supervisor.list() };
            case "pair":
                return { kind: "ready", ...(await supervisor.pair(command.arguments, requestSignal)) };
            case "start":
                return {
                    kind: "ready",
                    alreadyOnline: false,
                    pair: await supervisor.start(command.arguments, requestSignal),
                };
            case "stop-pair":
                return { kind: "pair-stopped", pair: await supervisor.stop(command.connectionId, requestSignal) };
            case "remove-pair":
                return {
                    kind: "pair-removed",
                    connectionId: await supervisor.remove(command.connectionId, requestSignal),
                };
        }
    };
    try {
        await supervisor.restore(combined);
        await serveLocalControl(installation.stateDirectory, "worker", combined, handle, () => {
            if (process.connected) {
                process.send?.({ kind: "worker-ready", version }, () => undefined);
            }
        });
    } finally {
        shutdown.abort();
        await supervisor.close();
        await release();
        process.off("disconnect", disconnected);
        if (process.connected) {
            process.disconnect();
        }
    }
}

async function acquireWorkerLock(stateDirectory: string, signal: AbortSignal): Promise<() => Promise<void>> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    for (;;) {
        deadline.throwIfAborted();
        const release = await acquireManagerLock(stateDirectory, "worker.lock");
        if (release !== null) {
            return release;
        }
        await setTimeout(25, undefined, { signal: deadline });
    }
}
