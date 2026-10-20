import { setTimeout } from "node:timers/promises";
import { MobiusRuntimeEngine } from "../../runtime/engine.ts";
import { acquireManagerLock, isNodeError, sendLocalRequest } from "../control/local-client.ts";
import { serveLocalControl } from "../control/local-server.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
    resumeMobiusRuntime,
} from "../pairing/pair-local-machine.ts";
import { prepareUpgradeData, recordCurrentData } from "../upgrades/data.ts";
import { runDaemonReleaseUpgrades } from "../upgrades/upgrade.ts";

class WorkerRuntimeError extends Error {
    readonly code = "worker_runtime_failed";
    constructor(connectionId: string, cause: unknown) {
        super(`Runtime ${connectionId} failed`, { cause });
    }
}

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
    try {
        await runWorkerRuntime(version, combined, shutdown);
    } finally {
        shutdown.abort();
        process.off("disconnect", disconnect);
        if (process.connected) {
            process.disconnect();
        }
    }
}

async function runWorkerRuntime(version: string, combined: AbortSignal, shutdown: AbortController): Promise<void> {
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
    const active = new Map<
        string,
        {
            readonly controller: AbortController;
            readonly completion: Promise<void>;
        }
    >();
    const fail = (connectionId: string, cause: unknown): void => {
        console.error(`Runtime ${connectionId} failed; stopping the daemon`, cause);
        shutdown.abort(new WorkerRuntimeError(connectionId, cause));
    };
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
                    .then(
                        () => {
                            if (!combined.aborted && !controller.signal.aborted) {
                                fail(connection.connectionId, new Error("The Runtime stopped unexpectedly"));
                            }
                        },
                        (cause: unknown) => {
                            if (!combined.aborted && !controller.signal.aborted) {
                                fail(connection.connectionId, cause);
                            }
                        },
                    )
                    .finally(() => active.delete(connection.connectionId));
                active.set(connection.connectionId, { controller, completion });
            } catch (cause) {
                combined.throwIfAborted();
                fail(connection.connectionId, cause);
                throw cause;
            }
        }
    };
    let reload: Promise<void> = Promise.resolve();
    let upgrades: Promise<void> = Promise.resolve();
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
            async () => {
                combined.throwIfAborted();
                await recordCurrentData(version, combined);
                upgrades = runDaemonReleaseUpgrades(combined);
                if (process.connected) {
                    process.send?.({ kind: "worker-ready", version }, () => undefined);
                }
            },
        );
        if (shutdown.signal.reason instanceof WorkerRuntimeError) {
            throw shutdown.signal.reason;
        }
    } finally {
        shutdown.abort();
        await upgrades;
        await reload;
        await Promise.all([...active.values()].map((running) => running.completion));
        await release();
    }
}
