import { setTimeout } from "node:timers/promises";
import { acquireManagerLock, isNodeError, sendLocalRequest } from "./daemon-local-control.ts";
import { serveLocalControl } from "./daemon-local-server.ts";
import { prepareUpgradeData } from "./daemon-upgrade-data.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
    resumeMobiusRuntime,
} from "./pairing/pair-local-machine.ts";
import { MobiusRuntimeEngine } from "./runtime.ts";

export async function reloadDaemon(stateDirectory: string, signal: AbortSignal): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, "worker", { kind: "reload" }, signal);
        if (
            typeof response !== "object" ||
            response === null ||
            !("kind" in response) ||
            response.kind !== "reloaded"
        ) {
            throw new Error("Saved configuration could not be applied to the running daemon");
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
}

export async function runWorker(version: string, signal: AbortSignal): Promise<void> {
    if (!process.connected) {
        throw new Error("The daemon must be started by its manager");
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const disconnect = (): void => shutdown.abort();
    process.once("disconnect", disconnect);
    const control = await openMobiusControlInstallation(combined, process.env);
    await prepareUpgradeData(control.stateDirectory, version, combined);
    const installation = await openMobiusCliInstallation(combined, process.env);
    const deadline = AbortSignal.any([combined, AbortSignal.timeout(15_000)]);
    let release: (() => Promise<void>) | null = null;
    while (release === null) {
        deadline.throwIfAborted();
        release = await acquireManagerLock(control.stateDirectory, "worker.lock");
        if (release === null) {
            await setTimeout(25, undefined, { signal: deadline });
        }
    }
    const active = new Map<string, { readonly controller: AbortController; readonly completion: Promise<void> }>();
    const reconcile = async (): Promise<void> => {
        const connections = await installation.listConnections(combined);
        const enabled = new Set(
            connections
                .filter((connection) => connection.activation === "active")
                .map((connection) => connection.connectionId),
        );
        for (const [id, running] of active) {
            if (enabled.has(id)) {
                continue;
            }
            running.controller.abort();
            await running.completion;
            active.delete(id);
        }
        for (const connection of connections) {
            if (!enabled.has(connection.connectionId) || active.has(connection.connectionId)) {
                continue;
            }
            try {
                const paired = await resumeMobiusRuntime(installation, connection.connectionId, combined);
                const controller = new AbortController();
                const engine = new MobiusRuntimeEngine(paired.config);
                const completion = engine
                    .run(AbortSignal.any([combined, controller.signal]))
                    .catch(() => {
                        if (!combined.aborted && !controller.signal.aborted) {
                            process.stderr.write(`Runtime ${connection.connectionId} failed.\n`);
                        }
                    })
                    .finally(() => active.delete(connection.connectionId));
                active.set(connection.connectionId, { controller, completion });
            } catch (_cause) {
                combined.throwIfAborted();
                process.stderr.write(`Could not load Runtime ${connection.connectionId}.\n`);
            }
        }
    };
    let reload: Promise<void> = Promise.resolve();
    try {
        await reconcile();
        await serveLocalControl(
            control.stateDirectory,
            "worker",
            combined,
            async (request) => {
                if (
                    typeof request !== "object" ||
                    request === null ||
                    !("kind" in request) ||
                    request.kind !== "reload"
                ) {
                    return { kind: "error", code: "invalid_reload", message: "Expected a configuration reload" };
                }
                const pending = reload.then(reconcile);
                reload = pending.catch(() => undefined);
                await pending;
                return { kind: "reloaded" };
            },
            () => {
                if (process.connected) {
                    process.send?.({ kind: "worker-ready", version }, () => undefined);
                }
            },
        );
    } finally {
        shutdown.abort();
        await reload;
        await Promise.all([...active.values()].map((running) => running.completion));
        await release();
        process.off("disconnect", disconnect);
        if (process.connected) {
            process.disconnect();
        }
    }
}
