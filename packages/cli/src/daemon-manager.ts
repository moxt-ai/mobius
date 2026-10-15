import { createServer, type Socket } from "node:net";
import {
    acquireManagerLock,
    controlSocketPath,
    readOrCreateControlToken,
    readSocketMessage,
} from "./daemon-manager-control.ts";
import { currentWorkerLaunch, decodeWorkerLaunch, isRecord, WorkerProcess } from "./daemon-worker-process.ts";
import { platformSupportFor } from "./platform/index.ts";
import type { RuntimeInstallationStore } from "./storage/runtime-installation-store.ts";

export { requestManager } from "./daemon-manager-client.ts";
export type { ManagedRuntimeStatus, ManagedRuntimeSummary, ManagerResponse } from "./daemon-manager-protocol.ts";

export async function runManager(
    installation: RuntimeInstallationStore,
    managerVersion: string,
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const release = await acquireManagerLock(installation.stateDirectory);
    if (release === null) {
        return;
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const platform = platformSupportFor(process.platform);
    const path = controlSocketPath(installation.stateDirectory);
    const sockets = new Set<Socket>();
    let worker: WorkerProcess | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    const execute = async (request: Readonly<Record<string, unknown>>): Promise<unknown> => {
        combined.throwIfAborted();
        if (request["kind"] === "stop") {
            return { kind: "stopped" };
        }
        const launch =
            request["kind"] === "execute"
                ? await decodeWorkerLaunch(request["launch"])
                : (worker?.launch ?? currentWorkerLaunch(managerVersion));
        const command = request["kind"] === "execute" ? request["command"] : { kind: "list" };
        if (
            worker === undefined ||
            !worker.running ||
            (request["kind"] === "execute" && worker.launch.version !== launch.version)
        ) {
            await worker?.close();
            worker = new WorkerProcess(launch, combined, environment);
            try {
                await worker.ready;
            } catch (cause) {
                await worker.close();
                throw cause;
            }
        }
        const response = await worker.request(command, combined);
        return isRecord(response) && response["kind"] === "listed"
            ? { ...response, managerVersion, managerProtocolVersion: 1 }
            : response;
    };
    const token = await readOrCreateControlToken(installation.stateDirectory);
    const serve = async (socket: Socket): Promise<void> => {
        try {
            const request = await readSocketMessage(socket, AbortSignal.any([combined, AbortSignal.timeout(130_000)]));
            if (
                !isRecord(request) ||
                request["token"] !== token ||
                !["list", "execute", "stop"].includes(String(request["kind"]))
            ) {
                throw new Error("Invalid manager request");
            }
            const response = queue.then(async () => await execute(request));
            queue = response.catch(() => undefined);
            const result = await response;
            if (request["kind"] === "stop") {
                socket.once("close", () => shutdown.abort());
                socket.end(`${JSON.stringify(result)}\n`, () => shutdown.abort());
            } else {
                socket.end(`${JSON.stringify(result)}\n`);
            }
        } catch {
            socket.end(
                `${JSON.stringify({ kind: "error", code: "manager_command_failed", message: "The manager could not complete the command" })}\n`,
            );
        }
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void serve(socket);
    });
    try {
        await platform.prepareControlSocket(path);
        server.listen(path);
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        await platform.secureControlSocket(path);
        if (!combined.aborted) {
            await new Promise<void>((resolve) => combined.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        shutdown.abort();
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await queue;
        await worker?.close();
        await platform.removeControlSocket(path).catch(() => undefined);
        await release();
    }
}
