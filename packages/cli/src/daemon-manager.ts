import { createServer, type Server, type Socket } from "node:net";
import {
    acquireManagerLock,
    controlSocketPath,
    readOrCreateControlToken,
    readSocketMessage,
} from "./daemon-manager-control.ts";
import { decodeCommand, errorMessage, type ManagerCommand, type ManagerResponse } from "./daemon-manager-protocol.ts";
import { RuntimeSupervisor } from "./daemon-runtime-supervisor.ts";
import { DaemonWorkerError } from "./daemon-worker-protocol.ts";
import { platformSupportFor } from "./platform/index.ts";
import type { RuntimeInstallationStore } from "./storage/runtime-installation-store.ts";

export { requestManager } from "./daemon-manager-client.ts";
export type { ManagedRuntimeStatus, ManagedRuntimeSummary, ManagerResponse } from "./daemon-manager-protocol.ts";

const managerPlatform = platformSupportFor(process.platform);

interface ConnectionContext {
    readonly supervisor: RuntimeSupervisor;
    readonly managerVersion: string;
    readonly token: string;
    readonly signal: AbortSignal;
    readonly shutdown: AbortController;
}

async function dispatchCommand(
    request: Exclude<ManagerCommand, { readonly kind: "stop" }>,
    context: ConnectionContext,
): Promise<ManagerResponse> {
    const { supervisor, managerVersion, signal } = context;
    switch (request.kind) {
        case "list":
            return { kind: "listed", managerVersion, pairs: supervisor.list() };
        case "pair": {
            const paired = await supervisor.pair(request.arguments, signal);
            return { alreadyOnline: paired.alreadyOnline, kind: "ready", pair: paired.pair };
        }
        case "start":
            return { alreadyOnline: false, kind: "ready", pair: await supervisor.start(request.arguments, signal) };
        case "stop-pair":
            return { kind: "pair-stopped", pair: await supervisor.stop(request.connectionId, signal) };
        case "remove-pair":
            return { connectionId: await supervisor.remove(request.connectionId, signal), kind: "pair-removed" };
    }
}

async function serveConnection(socket: Socket, context: ConnectionContext): Promise<void> {
    try {
        const request = decodeCommand(await readSocketMessage(socket, context.signal), context.token);
        if (request.kind === "stop") {
            const beginShutdown = (): void => context.shutdown.abort();
            socket.once("close", beginShutdown);
            socket.once("error", beginShutdown);
            socket.end(`${JSON.stringify({ kind: "stopped" })}\n`, beginShutdown);
            return;
        }
        const response = await dispatchCommand(request, context);
        socket.end(`${JSON.stringify(response)}\n`);
    } catch (cause) {
        const response: ManagerResponse = {
            kind: "error",
            code: cause instanceof DaemonWorkerError ? cause.code : "manager_command_failed",
            message: errorMessage(cause),
        };
        socket.end(`${JSON.stringify(response)}\n`);
    }
}

async function restoreConnections(supervisor: RuntimeSupervisor, signal: AbortSignal): Promise<void> {
    try {
        await supervisor.restore(signal);
    } catch (cause) {
        signal.throwIfAborted();
        process.stderr.write(`Could not restore saved Runtime connections: ${errorMessage(cause)}\n`);
    }
}

export async function runManager(
    installation: RuntimeInstallationStore,
    managerVersion: string,
    signal: AbortSignal,
): Promise<void> {
    const releaseLock = await acquireManagerLock(installation.stateDirectory);
    if (releaseLock === null) {
        return;
    }
    const socketPath = controlSocketPath(installation.stateDirectory);
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const supervisor = new RuntimeSupervisor(installation, combined);
    const sockets = new Set<Socket>();
    let server: Server | undefined;
    try {
        const token = await readOrCreateControlToken(installation.stateDirectory);
        await restoreConnections(supervisor, combined);
        if (combined.aborted) {
            return;
        }
        const context: ConnectionContext = { supervisor, managerVersion, token, signal: combined, shutdown };
        server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            void serveConnection(socket, context);
        });
        await managerPlatform.prepareControlSocket(socketPath);
        const listeningServer = server;
        await new Promise<void>((resolve, reject) => {
            listeningServer.once("listening", resolve);
            listeningServer.once("error", reject);
            listeningServer.listen(socketPath);
        });
        await managerPlatform.secureControlSocket(socketPath);
        if (!combined.aborted) {
            await new Promise<void>((resolve) => combined.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        shutdown.abort();
        for (const socket of sockets) {
            socket.destroy();
        }
        const closingServer = server;
        if (closingServer?.listening) {
            await new Promise<void>((resolve) => closingServer.close(() => resolve()));
        }
        await supervisor.close();
        await managerPlatform.removeControlSocket(socketPath).catch(() => undefined);
        await releaseLock();
    }
}
