// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { type MobiusWebSocketConnector, WsTransport } from "../src/platform.ts";

class BrowserWebSocket extends EventTarget implements WebSocket {
    readonly CLOSED = WebSocket.CLOSED;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    onclose: WebSocket["onclose"] = null;
    onerror: WebSocket["onerror"] = null;
    onmessage: WebSocket["onmessage"] = null;
    onopen: WebSocket["onopen"] = null;
    readonly protocol = "";
    readyState: WebSocket["readyState"] = WebSocket.OPEN;
    readonly url: string;
    closedWith: { readonly code: number; readonly reason: string } | null = null;

    constructor(url: string) {
        super();
        this.url = url;
    }

    readonly close = (code = 1000, reason = ""): void => {
        if (code !== 1000 && (code < 3000 || code > 4999)) {
            throw new DOMException("The close code is reserved", "InvalidAccessError");
        }
        this.closedWith = { code, reason };
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
    };

    readonly send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        if (typeof data !== "string") {
            throw new Error("Expected a text WebSocket request");
        }
        const value: unknown = JSON.parse(data);
        if (typeof value !== "object" || value === null) {
            throw new Error("Expected a WebSocket message");
        }
        if (!("requestId" in value)) {
            throw new Error("Expected a request identifier");
        }
        const requestId = value.requestId;
        if (typeof requestId !== "string") {
            throw new Error("Expected a string request identifier");
        }
        queueMicrotask(() => {
            this.dispatchEvent(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        body: "",
                        headers: [],
                        kind: "http.response",
                        requestId,
                        status: 204,
                    }),
                }),
            );
        });
    };
}

class BrowserWebSocketConnector implements MobiusWebSocketConnector {
    readonly sockets: BrowserWebSocket[] = [];

    readonly connect = async (endpoint: URL, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        const socket = new BrowserWebSocket(endpoint.toString());
        this.sockets.push(socket);
        return socket;
    };
}

afterEach(() => {
    vi.useRealTimers();
});

it("Given an idle browser transport, When its connection expires, Then it closes cleanly and the next request reconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector, idleTimeoutMilliseconds: 1_000 });

    expect((await transport.fetch(new Request("https://relay.example.test/first"))).status).toBe(204);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connector.sockets[0]?.closedWith).toEqual({
        code: 4000,
        reason: "Mobius transport idle timeout",
    });
    expect((await transport.fetch(new Request("https://relay.example.test/second"))).status).toBe(204);
    expect(connector.sockets).toHaveLength(2);

    transport.close();
});
