import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LifecycleResponse, lifecycleResponse } from "./daemon-lifecycle-protocol.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, isNodeError, sendLocalRequest } from "./daemon-local-control.ts";
import { currentWorkerLaunch } from "./daemon-worker-process.ts";

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

export async function ensureWorkingProcess(
    stateDirectory: string,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    await ensureManager(stateDirectory, version, deadline);
    const response = lifecycleResponse.parse(
        await sendLocalRequest(
            stateDirectory,
            "manager",
            { kind: "ensure", launch: currentWorkerLaunch(version) },
            deadline,
        ),
    );
    if (response.kind === "error") {
        throw new Error(response.message);
    }
    if (response.kind !== "status" || response.worker?.version !== version) {
        throw new Error("The working daemon did not start");
    }
}

async function ensureManager(stateDirectory: string, managerVersion: string, signal: AbortSignal): Promise<void> {
    let managerStarted = false;
    while (!signal.aborted) {
        try {
            const response = lifecycleResponse.safeParse(
                await sendLocalRequest(stateDirectory, "manager", { kind: "status" }, signal),
            );
            if (response.success && response.data.kind === "status") {
                if (managerStarted) {
                    process.stdout.write(`Mobius daemon ${managerVersion} started\n`);
                }
                return;
            }
            // Replace an older lifecycle protocol once; subsequent worker upgrades keep this manager.
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

export async function stopManager(
    stateDirectory: string,
    signal: AbortSignal,
): Promise<Extract<LifecycleResponse, { kind: "stopped" }>> {
    try {
        const response = lifecycleResponse.parse(
            await sendLocalRequest(stateDirectory, "manager", { kind: "stop" }, signal),
        );
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
