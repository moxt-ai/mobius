import { createServer, type Socket } from "node:net";
import { readOrCreateControlToken } from "../../storage/daemon/control-token.ts";
import { platformSupportFor } from "../../util/platform/index.ts";
import { controlSocketPath, readSocketMessage } from "./local-client.ts";

export async function serveLocalControl(
    stateDirectory: string,
    endpoint: "manager" | "worker",
    signal: AbortSignal,
    handle: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    onListening: () => void | Promise<void> = () => undefined,
    onResponse: (response: unknown) => void = () => undefined,
): Promise<void> {
    signal.throwIfAborted();
    const token = await readOrCreateControlToken(stateDirectory);
    const platform = platformSupportFor(process.platform);
    const path = controlSocketPath(stateDirectory, endpoint);
    const sockets = new Set<Socket>();
    const requests = new Set<Promise<void>>();
    const serve = async (socket: Socket): Promise<void> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(130_000)]);
        try {
            const request = await readSocketMessage(socket, deadline);
            if (typeof request !== "object" || request === null || !("token" in request) || request.token !== token) {
                socket.end(
                    `${JSON.stringify({ kind: "error", code: "unauthorized", message: "Invalid local control token" })}\n`,
                );
                return;
            }
            const response = await handle(request, deadline);
            socket.end(`${JSON.stringify(response)}\n`, () => onResponse(response));
        } catch {
            if (!signal.aborted) {
                socket.end(
                    `${JSON.stringify({ kind: "error", code: "control_request_failed", message: "Local control request failed" })}\n`,
                );
            }
        }
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        const request = serve(socket);
        requests.add(request);
        void request.finally(() => requests.delete(request));
    });
    try {
        await platform.prepareControlSocket(path);
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
            server.listen(path);
        });
        await platform.secureControlSocket(path);
        await onListening();
        if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled(requests);
        await platform.removeControlSocket(path).catch(() => undefined);
    }
}
