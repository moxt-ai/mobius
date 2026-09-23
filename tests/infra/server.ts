import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { coupleWebSocket, WebSocket as WorkerWebSocket } from "miniflare";
import { WebSocketServer } from "ws";
import { SocketResponse } from "./peers.ts";

export interface TestServerApp {
    readonly request: (request: Request) => Response | Promise<Response>;
}

function requestHeaders(request: IncomingMessage): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        } else if (value !== undefined) {
            headers.set(name, value);
        }
    }
    return headers;
}

/** Real HTTP/WebSocket transport for a Runtime talking to a caller-owned Hono app. */
export async function serveTestApp(options: {
    readonly app: TestServerApp;
    readonly signal: AbortSignal;
    readonly onServerMessage: (message: string) => void;
}) {
    options.signal.throwIfAborted();
    const sockets = new WebSocketServer({ noServer: true });
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
            }
            const streaming = request.headers.accept?.startsWith("text/event-stream") === true;
            const result = await options.app.request(
                new Request(new URL(request.url ?? "/", "http://mobius.test"), {
                    method: request.method ?? "GET",
                    headers: requestHeaders(request),
                    signal: streaming ? options.signal : AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
                    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
                }),
            );
            response.writeHead(result.status, Object.fromEntries(result.headers));
            if (result.body === null) {
                response.end();
                return;
            }
            await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]), response);
        } catch (cause) {
            if (options.signal.aborted) {
                response.end();
                return;
            }
            response.destroy(cause instanceof Error ? cause : undefined);
        }
    });
    server.on("upgrade", (request, socket, head) => {
        void (async () => {
            const appRequest = new Request(new URL(request.url ?? "/", "http://mobius.test"), {
                headers: requestHeaders(request),
                signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
            });
            appRequest.headers.set("upgrade", "websocket");
            const result = await options.app.request(appRequest);
            const peer: unknown = result instanceof SocketResponse ? result.socket : Reflect.get(result, "webSocket");
            if (result.status !== 101 || !(peer instanceof WorkerWebSocket)) {
                await result.body?.cancel();
                socket.end(`HTTP/1.1 ${result.status} Rejected\r\nConnection: close\r\n\r\n`);
                return;
            }
            peer.addEventListener("message", (event) => {
                if (typeof event.data === "string") {
                    options.onServerMessage(event.data);
                }
            });
            sockets.handleUpgrade(request, socket, head, (client) => {
                void coupleWebSocket(client, peer).catch(() => client.terminate());
            });
        })().catch((cause: unknown) => socket.destroy(cause instanceof Error ? cause : undefined));
    });
    const close = async () => {
        for (const client of sockets.clients) {
            client.terminate();
        }
        server.closeAllConnections();
        await Promise.all([
            new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve()))),
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        ]);
    };
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected the test server address");
        }
        return { origin: `http://127.0.0.1:${address.port}`, [Symbol.asyncDispose]: close };
    } catch (cause) {
        server.closeAllConnections();
        server.close();
        sockets.close();
        throw cause;
    }
}
