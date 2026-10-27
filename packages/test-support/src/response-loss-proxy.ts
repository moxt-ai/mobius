import { createServer, request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { listen, port } from "./websocket.ts";

/** A real network proxy: forwards requests unchanged, then loses one turn admission response. */
export async function createResponseLossProxy(upstream: string) {
    let forkResponse: ((status: number) => void) | null = null;
    const server = createServer((incoming, outgoing) => {
        const forwarded = request(
            new URL(incoming.url ?? "/", upstream),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                if (
                    forkResponse !== null &&
                    incoming.method === "POST" &&
                    incoming.url?.includes("/native-session-forks/")
                ) {
                    const lost = forkResponse;
                    forkResponse = null;
                    response.resume();
                    response.on("end", () => {
                        lost(response.statusCode ?? 502);
                        outgoing.destroy();
                    });
                    return;
                }
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.on("aborted", () => forwarded.destroy());
        incoming.pipe(forwarded);
    });
    const sockets = new Set<WebSocket>();
    const webSockets = new WebSocketServer({ server });
    let armed: "before-acceptance" | "after-acceptance" | null = null;
    let reconnectsBlocked = false;
    const submissions: string[] = [];
    webSockets.on("connection", (client, incoming) => {
        if (reconnectsBlocked) {
            client.terminate();
            return;
        }
        sockets.add(client);
        const target = new URL(incoming.url ?? "/", upstream);
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
        });
        sockets.add(remote);
        let lostRequestId: string | null = null;
        const pending: { readonly data: Buffer; readonly binary: boolean }[] = [];
        client.on("message", (data, binary) => {
            const bytes = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(new Uint8Array(data));
            if (!binary) {
                const frame: unknown = JSON.parse(bytes.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    frame.path.endsWith("/turns") &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string" &&
                    "body" in frame &&
                    typeof frame.body === "string"
                ) {
                    submissions.push(frame.body);
                    if (armed !== null) {
                        const delivery = armed;
                        armed = null;
                        if (delivery === "before-acceptance") {
                            reconnectsBlocked = true;
                            client.terminate();
                            remote.terminate();
                            return;
                        }
                        lostRequestId = frame.requestId;
                    }
                }
            }
            if (remote.readyState === WebSocket.OPEN) {
                remote.send(bytes, { binary });
            } else {
                pending.push({ data: bytes, binary });
            }
        });
        remote.on("open", () => {
            for (const frame of pending.splice(0)) {
                remote.send(frame.data, { binary: frame.binary });
            }
        });
        remote.on("message", (data, binary) => {
            if (lostRequestId !== null) {
                const frame: unknown = binary ? null : JSON.parse(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    frame.requestId === lostRequestId
                ) {
                    // The service accepted the request. Lose its response and any confirming live events.
                    reconnectsBlocked = true;
                    client.terminate();
                    remote.terminate();
                }
                return;
            }
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary });
            }
        });
        client.on("error", () => remote.terminate());
        remote.on("error", () => client.terminate());
        client.on("close", () => {
            sockets.delete(client);
            remote.terminate();
        });
        remote.on("close", () => {
            sockets.delete(remote);
            client.terminate();
        });
    });
    await listen(server);
    return {
        origin: `http://127.0.0.1:${port(server)}`,
        submissions,
        interruptNextFork: () =>
            new Promise<number>((resolve) => {
                forkResponse = resolve;
            }),
        interruptNextTurn: (delivery: "before-acceptance" | "after-acceptance") => {
            armed = delivery;
        },
        reconnect: () => {
            reconnectsBlocked = false;
        },
        close: async () => {
            for (const socket of sockets) {
                socket.terminate();
            }
            webSockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
