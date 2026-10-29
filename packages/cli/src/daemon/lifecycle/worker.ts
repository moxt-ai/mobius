import { setTimeout } from "node:timers/promises";
import { refreshAgentCatalog } from "../../engine/runtime/catalog/refresh-agent-catalog.ts";
import type { RuntimeConfig } from "../../engine/runtime/config.ts";
import { RuntimeInstallationStore } from "../../engine/runtime/connection/runtime-installation-store.ts";
import { prepareRuntimeConnection } from "../../engine/runtime/pairing.ts";
import { RuntimeLoop } from "../../engine/runtime/runtime-loop.ts";
import { RuntimeAgentProcesses } from "../../engine/session/process/runtime-agent-processes.ts";
import { RuntimeTurnActivity } from "../../engine/session/turn/runtime-turn-activity.ts";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { acquireManagerLock } from "../../storage/daemon/manager-lock.ts";
import { prepareMobiusEngineDataDir, resolveMaxAcpProcesses } from "../config.ts";
import { sendLocalRequest } from "../control/local-client.ts";
import { serveLocalControl } from "../control/local-server.ts";
import { openMobiusControlInstallation } from "../pairing/pair-local-machine.ts";
import { prepareUpgradeData, recordCurrentData } from "../upgrades/data.ts";
import { reportDaemonUpgradeAvailability, runDaemonReleaseUpgrades } from "../upgrades/upgrade.ts";
import { surviveUnhandledRejections, type UnhandledRejectionGuard } from "./unhandled-rejection.ts";

class WorkerRuntimeError extends Error {
    readonly code = "worker_runtime_failed";
    constructor(connectionId: string, cause: unknown) {
        super(`Runtime ${connectionId} failed`, { cause });
    }
}

export async function reloadDaemon(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
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

/** Releases idle Agent processes of a running daemon; succeeds when no daemon is running. */
export async function releaseIdleAgentProcesses(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, "worker", { kind: "release" }, signal);
        if (typeof response === "object" && response !== null && "kind" in response && response.kind === "released") {
            return;
        }
        throw new Error("The running daemon cannot release Agent sessions. Run `mobius start` to update it first.");
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
    // Install before any await: an unhandled rejection during startup itself
    // must not kill the worker before the guard exists.
    const rejectionGuard = surviveUnhandledRejections("worker");
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const disconnect = (): void => shutdown.abort();
    process.once("disconnect", disconnect);
    try {
        await runWorkerRuntime(version, combined, shutdown, rejectionGuard);
    } finally {
        shutdown.abort();
        process.off("disconnect", disconnect);
        rejectionGuard.release();
        if (process.connected) {
            process.disconnect();
        }
    }
}

async function runWorkerRuntime(
    version: string,
    combined: AbortSignal,
    shutdown: AbortController,
    rejectionGuard: UnhandledRejectionGuard,
): Promise<void> {
    const control = await openMobiusControlInstallation(combined, process.env);
    await prepareUpgradeData(control.stateDirectory, version, combined);
    const engineDataDir = await prepareMobiusEngineDataDir(version, combined, process.env);
    const installation = await RuntimeInstallationStore.open(engineDataDir, combined);
    const deadline = AbortSignal.any([combined, AbortSignal.timeout(15_000)]);
    let release: (() => Promise<void>) | null = null;
    while (release === null) {
        deadline.throwIfAborted();
        release = await acquireManagerLock(control.stateDirectory, "worker.lock");
        if (release === null) {
            await setTimeout(25, undefined, { signal: deadline });
        }
    }
    // The lock makes this process the only worker, and therefore the only
    // writer of the worker's rejection log; buffered startup entries flush now.
    rejectionGuard.bindStateDirectory(control.stateDirectory);
    const turnActivity = new RuntimeTurnActivity();
    const agentProcesses = new RuntimeAgentProcesses();
    const active = new Map<
        string,
        {
            readonly config: RuntimeConfig;
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
                const config = await prepareRuntimeConnection(
                    installation,
                    connection,
                    combined,
                    process.env,
                    resolveMaxAcpProcesses(process.env),
                );
                const controller = new AbortController();
                // The manager writes the worker lifecycle and rejection logs beside
                // the control directory, not beside this Runtime's own state, so a
                // bug report taken through this Runtime reads them from there.
                const loop = new RuntimeLoop(async () => config, {
                    processLogsDirectory: control.stateDirectory,
                    turnActivity,
                    agentProcesses,
                    reportUpgradeAvailability: reportDaemonUpgradeAvailability,
                });
                const completion = loop
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
                active.set(connection.connectionId, { config, controller, completion });
            } catch (cause) {
                combined.throwIfAborted();
                fail(connection.connectionId, cause);
                throw cause;
            }
        }
    };
    const refreshRunningCatalogs = async (connectionIds: ReadonlySet<string>): Promise<void> => {
        await Promise.all(
            [...connectionIds].map(async (connectionId) => {
                const config = active.get(connectionId)?.config;
                if (config?.rediscoverAgents === undefined) {
                    return;
                }
                try {
                    await refreshAgentCatalog(
                        config,
                        config.rediscoverAgents,
                        AbortSignal.any([combined, AbortSignal.timeout(90_000)]),
                    );
                } catch (cause) {
                    combined.throwIfAborted();
                    // The Runtime keeps serving its previous catalog; the reload itself still applies.
                    console.error(`Runtime ${connectionId} could not refresh its Agent catalog`, cause);
                }
            }),
        );
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
                    typeof request === "object" &&
                    request !== null &&
                    "kind" in request &&
                    request.kind === "release"
                ) {
                    // Agents' own clients can continue the conversations that idle processes held.
                    await agentProcesses.retireIdleProcesses();
                    return { kind: "released" };
                }
                if (
                    typeof request !== "object" ||
                    request === null ||
                    !("kind" in request) ||
                    request.kind !== "reload"
                ) {
                    return { kind: "error", code: "invalid_reload", message: "Expected a configuration reload" };
                }
                // A reload, such as `mobius start` after the user installs or signs in to an Agent, also re-reads the
                // Agent inventory of Runtimes that were already running; Runtimes it starts read it themselves.
                const running = new Set(active.keys());
                const pending = reload.then(reconcile).then(async () => await refreshRunningCatalogs(running));
                reload = pending.catch(() => undefined);
                await pending;
                return { kind: "reloaded" };
            },
            async () => {
                combined.throwIfAborted();
                await recordCurrentData(version, combined);
                upgrades = runDaemonReleaseUpgrades(combined, turnActivity);
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
