import { sendLocalRequest } from "./daemon-local-control.ts";
import { ensureWorkingProcess, stopManager } from "./daemon-manager-client.ts";
import { type WorkerCommand, type WorkerResponse, workerResponse } from "./daemon-worker-protocol.ts";
import type { RuntimeInstallationStore } from "./storage/runtime-installation-store.ts";

export async function requestDaemon(
    installation: RuntimeInstallationStore,
    version: string,
    command: WorkerCommand | { readonly kind: "stop" },
    signal: AbortSignal,
): Promise<WorkerResponse | { readonly kind: "stopped" }> {
    if (command.kind === "stop") {
        return await stopManager(installation.stateDirectory, signal);
    }
    await ensureWorkingProcess(installation.stateDirectory, version, signal);
    return workerResponse.parse(
        await sendLocalRequest(installation.stateDirectory, "worker", { version, command }, signal),
    );
}
