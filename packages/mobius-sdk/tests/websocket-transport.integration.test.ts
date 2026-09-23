// @vitest-environment happy-dom

import {
    type CommittedSessionEvent,
    encodeCommittedSessionEvent,
    SESSION_INFO_UPDATED_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
    MobiusClient,
    type MobiusHttpTransport,
    type MobiusLiveEventTransport,
    type MobiusTransportSessionEvent,
    StaticMobiusCredentialProvider,
} from "../src/index.ts";
import { type MobiusWebSocketConnector, WsTransport } from "../src/platform.ts";

const liveEvent: CommittedSessionEvent = {
    cursor: "event-cursor",
    eventId: "event-1",
    kind: "session.event.committed",
    payload: JSON.stringify({
        kind: SESSION_INFO_UPDATED_KIND,
        sessionId: "session-1",
        title: "Recovered",
        updatedAt: "2030-01-01T00:00:00.000Z",
    }),
    recordedAt: "2030-01-01T00:00:00.000Z",
    sequence: "1",
    sessionId: "session-1",
    source: { kind: "runtime", sourceSeq: "1" },
};

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
        if ("kind" in value && value.kind === "session.events.unsubscribe") {
            return;
        }
        if ("kind" in value && value.kind === "session.events.subscribe") {
            if (!("subscriptionId" in value) || typeof value.subscriptionId !== "string") {
                throw new Error("Expected a subscription identifier");
            }
            const subscriptionId = value.subscriptionId;
            queueMicrotask(() => {
                this.dispatchEvent(
                    new MessageEvent("message", {
                        data: JSON.stringify({ kind: "session.events.ready", subscriptionId }),
                    }),
                );
                queueMicrotask(() =>
                    this.dispatchEvent(
                        new MessageEvent("message", {
                            data: JSON.stringify({
                                data: encodeCommittedSessionEvent(liveEvent),
                                eventId: "event-cursor",
                                kind: "session.events.event",
                                subscriptionId,
                            }),
                        }),
                    ),
                );
            });
            return;
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

class RecoveringLiveTransport implements MobiusHttpTransport, MobiusLiveEventTransport {
    readonly #controllers: ReadableStreamDefaultController<MobiusTransportSessionEvent>[] = [];

    readonly fetch = (): Promise<Response> => Promise.reject(new Error("Live events must not use fetch"));

    readonly openLiveSessionEvents = (request: Request): Promise<ReadableStream<MobiusTransportSessionEvent>> => {
        request.signal.throwIfAborted();
        return Promise.resolve(
            new ReadableStream<MobiusTransportSessionEvent>({
                start: (controller) => {
                    this.#controllers.push(controller);
                    controller.enqueue({ data: encodeCommittedSessionEvent(liveEvent), eventId: liveEvent.cursor });
                },
            }),
        );
    };

    readonly disconnect = (connection: number): void => {
        this.#controllers[connection]?.error(new Error("The live transport disconnected"));
    };

    get connections(): number {
        return this.#controllers.length;
    }
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

it("Given an existing browser transport socket, When live Session events are subscribed, Then typed events use that same socket", async () => {
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });
    expect((await transport.fetch(new Request("https://relay.example.test/session"))).status).toBe(204);

    const events = await transport.openLiveSessionEvents(
        new Request("https://relay.example.test/mobius/api/v1/projects/project-1/sessions/session-1/events"),
    );
    const reader = events.getReader();

    await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { data: encodeCommittedSessionEvent(liveEvent), eventId: "event-cursor" },
    });
    expect(connector.sockets).toHaveLength(1);

    await reader.cancel();
    transport.close();
});

it("Given live events disconnect, When a fresh subscription is established, Then reconciliation runs before resumed delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const transport = new RecoveringLiveTransport();
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider("credential"),
        endpoint: "https://relay.example.test",
        maxStreamReconnectAttempts: 2,
        projectId: "project-1",
        transport,
    });
    const observations: string[] = [];
    let deliveries = 0;
    let firstDelivered = (): void => undefined;
    const first = new Promise<void>((resolve) => {
        firstDelivered = resolve;
    });
    let resumedDelivery = (): void => undefined;
    const resumed = new Promise<void>((resolve) => {
        resumedDelivery = resolve;
    });
    const subscription = await client.events.subscribeLive(
        "session-1",
        {
            reconcile: async (connection) => {
                observations.push(`reconcile:${connection.kind}`);
            },
            receive: async () => {
                deliveries += 1;
                observations.push(`event:${deliveries}`);
                if (deliveries === 1) {
                    transport.disconnect(0);
                    firstDelivered();
                    return true;
                }
                resumedDelivery();
                return false;
            },
        },
        new AbortController().signal,
    );

    await first;
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await resumed;
    await subscription.completed;

    expect(transport.connections).toBe(2);
    expect(observations).toEqual(["reconcile:initial", "event:1", "reconcile:reconnected", "event:2"]);
    client.close();
});
