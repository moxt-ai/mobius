import { setTimeout } from "node:timers/promises";
import { acquireManagerLock } from "./daemon-manager-control.ts";
import { decodeCommand } from "./daemon-manager-protocol.ts";
import { RuntimeSupervisor } from "./daemon-runtime-supervisor.ts";
import { isRecord } from "./daemon-worker-process.ts";
import { openMobiusCliInstallation } from "./pairing/pair-local-machine.ts";

export async function runWorker(version: string, signal: AbortSignal): Promise<void> {
    if (!process.connected) {
        throw new Error("The working daemon must be started by its manager");
    }
    const shutdown = new AbortController();
    const disconnected = (): void => shutdown.abort();
    process.once("disconnect", disconnected);
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const installation = await openMobiusCliInstallation(combined, process.env);
    const release = await acquireWorkerLock(installation.stateDirectory, combined);
    const supervisor = new RuntimeSupervisor(installation);
    const restoring = supervisor.restore(combined);
    const pending = new Set<Promise<void>>();
    const handle = async (value: unknown): Promise<void> => {
        if (!isRecord(value) || typeof value["id"] !== "number") {
            return;
        }
        let response: unknown;
        try {
            await restoring;
            if (!isRecord(value["command"])) {
                throw new Error("Invalid worker command");
            }
            const command = decodeCommand({ ...value["command"], token: "ipc" }, "ipc");
            switch (command.kind) {
                case "list":
                    response = {
                        kind: "listed",
                        managerVersion: version,
                        workerVersion: version,
                        pairs: supervisor.list(),
                    };
                    break;
                case "pair":
                    response = { kind: "ready", ...(await supervisor.pair(command.arguments, combined)) };
                    break;
                case "start":
                    response = {
                        kind: "ready",
                        alreadyOnline: false,
                        pair: await supervisor.start(command.arguments, combined),
                    };
                    break;
                case "stop-pair":
                    response = { kind: "pair-stopped", pair: await supervisor.stop(command.connectionId, combined) };
                    break;
                case "remove-pair":
                    response = {
                        kind: "pair-removed",
                        connectionId: await supervisor.remove(command.connectionId, combined),
                    };
                    break;
                case "stop":
                    throw new Error("Stop belongs to the manager");
            }
        } catch {
            response = {
                kind: "error",
                code: "worker_command_failed",
                message: "The working daemon could not complete the command",
            };
        }
        if (process.connected) {
            process.send?.({ id: value["id"], response }, () => undefined);
        }
    };
    const receive = (value: unknown): void => {
        const request = handle(value);
        pending.add(request);
        void request.finally(() => pending.delete(request));
    };
    process.on("message", receive);
    try {
        await restoring;
        if (process.connected) {
            process.send?.({ kind: "worker-ready", version });
        }
        if (!combined.aborted) {
            await new Promise<void>((resolve) => combined.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        shutdown.abort();
        process.off("message", receive);
        await Promise.allSettled(pending);
        await supervisor.close();
        await release();
        process.off("disconnect", disconnected);
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
