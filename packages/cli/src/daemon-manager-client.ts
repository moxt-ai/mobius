import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTROL_TIMEOUT_MILLISECONDS, isNodeError, sendControlRequest } from "./daemon-manager-control.ts";
import type { ManagerCommand, ManagerResponse } from "./daemon-manager-protocol.ts";
import { currentWorkerLaunch } from "./daemon-worker-process.ts";
import type { RuntimeInstallationStore } from "./storage/runtime-installation-store.ts";

async function spawnManager(): Promise<ChildProcess> {
    const child = spawn(process.execPath, [process.argv[1] ?? "", "__manager"], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    child.unref();
    return child;
}

async function launchManager(managerVersion: string): Promise<void> {
    process.stdout.write(`Starting mobius daemon ${managerVersion}\n`);
    await spawnManager();
}

async function waitForManagerExit(stateDirectory: string, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!deadline.aborted) {
        try {
            await readFile(join(stateDirectory, "manager.lock"), "utf8");
        } catch (cause) {
            if (isNodeError(cause, "ENOENT")) {
                return;
            }
            throw cause;
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

export async function requestManager(
    installation: RuntimeInstallationStore,
    managerVersion: string,
    command: ManagerCommand,
    signal: AbortSignal,
): Promise<ManagerResponse> {
    if (managerVersion.length === 0 || managerVersion.length > 128) {
        throw new Error("The Mobius manager version is invalid");
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    if (command.kind === "stop") {
        return await stopManager(installation.stateDirectory, deadline);
    }
    await ensureMatchingManager(installation.stateDirectory, managerVersion, deadline);
    return await sendControlRequest(
        installation.stateDirectory,
        { kind: "execute", launch: currentWorkerLaunch(managerVersion), command },
        deadline,
    );
}

async function ensureMatchingManager(
    stateDirectory: string,
    managerVersion: string,
    signal: AbortSignal,
): Promise<Extract<ManagerResponse, { readonly kind: "listed" }>> {
    let managerStarted = false;
    while (!signal.aborted) {
        try {
            const response = await sendControlRequest(stateDirectory, { kind: "list" }, signal);
            if (response.kind === "listed" && response.managerProtocolVersion === 1) {
                if (managerStarted) {
                    process.stdout.write(`Mobius daemon ${managerVersion} started\n`);
                }
                return response;
            }
            if (response.kind !== "listed") {
                if (response.kind === "error") {
                    throw new Error(response.message);
                }
                throw new Error("The Mobius manager returned an unexpected response");
            }
            await stopManager(stateDirectory, signal);
            await launchManager(managerVersion);
            managerStarted = true;
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!managerStarted) {
                await launchManager(managerVersion);
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

async function stopManager(
    stateDirectory: string,
    signal: AbortSignal,
): Promise<Extract<ManagerResponse, { kind: "stopped" }>> {
    try {
        const response = await sendControlRequest(stateDirectory, { kind: "stop" }, signal);
        if (response.kind === "error") {
            throw new Error(response.message);
        }
        if (response.kind !== "stopped") {
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
