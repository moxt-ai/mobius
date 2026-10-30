import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { managerLockExists } from "../../storage/daemon/manager-lock.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, sendLocalRequest } from "../control/local-client.ts";
import { decodeKnownLifecycleResponse, type LifecycleResponse, type WorkerLaunch } from "../control/protocol.ts";
import { resolveLatestDaemonLaunch } from "../upgrades/package.ts";

async function spawnManager(launch: WorkerLaunch): Promise<ChildProcess> {
    const child = spawn(launch.executable, [launch.entry, "__manager"], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    await once(child, "spawn");
    child.unref();
    return child;
}

async function launchManager(launch: WorkerLaunch): Promise<ChildProcess> {
    process.stdout.write(`Starting mobius daemon ${launch.version}\n`);
    return await spawnManager(launch);
}

async function waitForManagerExit(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!deadline.aborted) {
        if (!(await managerLockExists(stateDirectory))) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(finish, 20);
            const abort = (): void => finish(deadline.reason);
            function finish(cause?: unknown): void {
                clearTimeout(timeout);
                deadline.removeEventListener("abort", abort);
                cause === undefined ? resolve() : reject(cause);
            }
            deadline.addEventListener("abort", abort, { once: true });
        });
    }
    throw deadline.reason;
}

// npx selects the release; the worker inherits the current version's data at startup.
export async function ensureWorkingProcess(
    stateDirectory: InstallationDirectory,
    _cliVersion: string,
    signal: AbortSignal,
): Promise<string> {
    const launch = await resolveLatestDaemonLaunch(signal);
    const version = launch.version;
    const running = await readWorkingProcessVersion(stateDirectory, signal);
    if (running !== null && running !== version) {
        await stopManager(stateDirectory, signal);
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    await ensureManager(stateDirectory, launch, deadline);
    const response = decodeKnownLifecycleResponse(
        await sendLocalRequest(stateDirectory, "manager", { kind: "ensure", launch }, deadline),
    );
    if (response?.kind === "error") {
        throw new Error(response.message);
    }
    if (response?.kind !== "status" || response.worker?.version !== version) {
        throw new Error("The working daemon did not start");
    }
    return version;
}

// Returns the running worker's version, or null when no compatible manager
// reports one. Callers fall back to ensureWorkingProcess to start a daemon.
export async function readWorkingProcessVersion(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<string | null> {
    try {
        const response = decodeKnownLifecycleResponse(
            await sendLocalRequest(stateDirectory, "manager", { kind: "status" }, signal),
        );
        if (response?.kind === "status") {
            return response.worker?.version ?? null;
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
    return null;
}

async function ensureManager(
    stateDirectory: InstallationDirectory,
    launch: WorkerLaunch,
    signal: AbortSignal,
): Promise<void> {
    let managerStarted = false;
    let child: ChildProcess | undefined;
    while (!signal.aborted) {
        if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
            throw new Error("The daemon exited before becoming ready");
        }
        try {
            const response = decodeKnownLifecycleResponse(
                await sendLocalRequest(stateDirectory, "manager", { kind: "status" }, signal),
            );
            if (response?.kind === "status") {
                if (managerStarted) {
                    process.stdout.write(`Mobius daemon ${launch.version} started\n`);
                }
                return;
            }
            throw new Error("The manager could not return its status");
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!managerStarted) {
                child = await launchManager(launch);
                managerStarted = true;
            }
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(finish, 50);
                const abort = (): void => finish(signal.reason);
                function finish(cause?: unknown): void {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", abort);
                    cause === undefined ? resolve() : reject(cause);
                }
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    }
    throw signal.reason;
}

export async function stopManager(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<Extract<LifecycleResponse, { kind: "stopped" }>> {
    try {
        const response = decodeKnownLifecycleResponse(
            await sendLocalRequest(stateDirectory, "manager", { kind: "stop" }, signal),
        );
        if (response?.kind === "error") {
            throw new Error(response.message);
        }
        if (response?.kind !== "stopped") {
            throw new Error("The Mobius manager returned an unexpected response");
        }
        await waitForManagerExit(stateDirectory, signal);
        return response;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT") || isNodeError(cause, "ECONNREFUSED")) {
            return { kind: "stopped" };
        }
        throw cause;
    }
}
