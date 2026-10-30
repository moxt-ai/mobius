import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { daemonLockExists } from "../../storage/daemon/daemon-lock.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, sendLocalRequest } from "../control/local-client.ts";
import { decodeKnownLifecycleResponse, type LifecycleResponse } from "../control/protocol.ts";

async function spawnDaemon(): Promise<ChildProcess> {
    const entry = process.argv[1];
    if (entry === undefined) {
        throw new Error("The CLI entrypoint is missing");
    }
    const child = spawn(process.execPath, [entry, "__daemon"], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    await once(child, "spawn");
    child.unref();
    return child;
}

async function launchDaemon(version: string): Promise<ChildProcess> {
    process.stdout.write(`Starting mobius daemon ${version}\n`);
    return await spawnDaemon();
}

async function waitForDaemonExit(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!deadline.aborted) {
        if (!(await daemonLockExists(stateDirectory))) {
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

// The invoking CLI owns the release. npx resolves it before any daemon is stopped.
export async function ensureDaemon(
    stateDirectory: InstallationDirectory,
    version: string,
    signal: AbortSignal,
): Promise<string> {
    const running = await readDaemonVersion(stateDirectory, signal);
    if (running !== null) {
        return running;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    await waitForDaemon(stateDirectory, version, deadline);
    return version;
}

// Status keeps the released wire format; the worker field identifies the daemon.
export async function readDaemonVersion(
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

async function waitForDaemon(
    stateDirectory: InstallationDirectory,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    let daemonStarted = false;
    let child: ChildProcess | undefined;
    while (!signal.aborted) {
        if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
            throw new Error("The daemon exited before becoming ready");
        }
        try {
            const response = decodeKnownLifecycleResponse(
                await sendLocalRequest(stateDirectory, "manager", { kind: "status" }, signal),
            );
            if (response?.kind === "status" && response.worker !== null) {
                if (daemonStarted) {
                    process.stdout.write(`Mobius daemon ${version} started\n`);
                }
                return;
            }
            throw new Error("The daemon could not return its status");
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!daemonStarted) {
                child = await launchDaemon(version);
                daemonStarted = true;
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

export async function stopDaemon(
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
            throw new Error("The Mobius daemon returned an unexpected response");
        }
        await waitForDaemonExit(stateDirectory, signal);
        return response;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT") || isNodeError(cause, "ECONNREFUSED")) {
            return { kind: "stopped" };
        }
        throw cause;
    }
}
