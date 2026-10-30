// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { MobiusClient, MobiusConnectionError, StaticMobiusCredentialProvider } from "../src/index.ts";
import { type MobiusWebSocketConnector, WsTransport } from "../src/platform.ts";
import { issueSessionAccessCredential } from "../src/protocol/index.ts";

const sessionCredential = await issueSessionAccessCredential(`mapp_${"a".repeat(22)}_${"b".repeat(43)}`, {
    issuedAtEpochMilliseconds: 0,
    expiresAtEpochMilliseconds: 900000,
    purpose: "session-access",
    projectId: "project-1",
    runtimeId: "runtime-1",
    sessionId: "session-1",
});

function runtimeRequest(address: string, init?: RequestInit): Request {
    const url = new URL(address);
    if (!url.pathname.startsWith("/mobius/api/v1/projects/")) {
        url.pathname = `/mobius/api/v1/projects/project-1/runtimes/runtime-1${url.pathname}`;
    } else {
        url.pathname = url.pathname.replace("/projects/project/", "/projects/project-1/");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${sessionCredential}`);
    return new Request(url, { ...init, headers });
}

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
    readonly liveness: "responsive" | "silent";
    readyState: WebSocket["readyState"] = WebSocket.OPEN;
    readonly subscriptionIds: string[] = [];
    readonly requestBodies: string[] = [];
    readonly responseBody: string;
    readonly url: string;
    closedWith: { readonly code: number; readonly reason: string } | null = null;

    constructor(url: string, responseBody = "", liveness: "responsive" | "silent" = "responsive") {
        super();
        this.responseBody = responseBody;
        this.url = url;
        this.liveness = liveness;
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
        if ("kind" in value && value.kind === "ping") {
            if (this.liveness === "responsive") {
                queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: '{"kind":"pong"}' })));
            }
            return;
        }
        if ("subscriptionId" in value) {
            if (typeof value.subscriptionId !== "string") {
                throw new Error("Expected a string subscription identifier");
            }
            this.subscriptionIds.push(value.subscriptionId);
            queueMicrotask(() => {
                this.dispatchEvent(
                    new MessageEvent("message", {
                        data: JSON.stringify({
                            kind: "session.events.ready",
                            subscriptionId: value.subscriptionId,
                        }),
                    }),
                );
            });
            return;
        }
        if (!("requestId" in value)) {
            throw new Error("Expected a request identifier or subscription identifier");
        }
        const requestId = value.requestId;
        if (typeof requestId !== "string") {
            throw new Error("Expected a string request identifier");
        }
        if (!("body" in value) || typeof value.body !== "string") {
            throw new Error("Expected a string request body");
        }
        this.requestBodies.push(value.body);
        queueMicrotask(() => {
            this.dispatchEvent(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        body: this.responseBody,
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
    #remainingReconnectFailures: number;
    connectAttempts = 0;
    readonly responseBody: string;
    readonly sockets: BrowserWebSocket[] = [];
    readonly liveness: "responsive" | "silent";

    constructor(reconnectFailures = 0, responseBody = "", liveness: "responsive" | "silent" = "responsive") {
        this.#remainingReconnectFailures = reconnectFailures;
        this.responseBody = responseBody;
        this.liveness = liveness;
    }

    readonly connect = async (endpoint: URL, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        this.connectAttempts += 1;
        if (this.connectAttempts > 1 && this.#remainingReconnectFailures > 0) {
            this.#remainingReconnectFailures -= 1;
            throw new Error("The controlled WebSocket reconnect failed because the network is unavailable");
        }
        const socket = new BrowserWebSocket(endpoint.toString(), this.responseBody, this.liveness);
        this.sockets.push(socket);
        return socket;
    };
}

afterEach(() => {
    vi.useRealTimers();
});

it("Given a browser bound to one Runtime, When it opens another Session or addresses another Runtime, Then Sessions share the connection and the other Runtime is rejected", async () => {
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });
    try {
        await transport.fetch(runtimeRequest("https://relay.example.test/first"));
        const events = await transport.openSessionLiveEvents(
            runtimeRequest("https://relay.example.test/mobius/api/v1/projects/project-1/sessions/session-2/events-v2"),
        );
        expect(connector.sockets).toHaveLength(1);
        expect(connector.sockets[0]?.url).toBe(
            "wss://relay.example.test/mobius/api/v1/projects/project-1/runtimes/runtime-1/transport",
        );
        await expect(
            transport.fetch(
                runtimeRequest("https://relay.example.test/mobius/api/v1/projects/project-1/runtimes/runtime-2/agents"),
            ),
        ).rejects.toThrow("cannot connect to multiple Runtimes");
        expect((await transport.fetch(runtimeRequest("https://relay.example.test/after-rejection"))).status).toBe(204);
        await events.cancel();
    } finally {
        transport.close();
    }
});

it("Given a quiet subscription with connection heartbeats, When multiple idle deadlines pass, Then its original stream still delivers events", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const connector = new BrowserWebSocketConnector(0, "", "responsive");
    const transport = new WsTransport({ connector });
    const stream = await transport.openSessionLiveEvents(
        runtimeRequest("https://relay.example.test/session/events-v2"),
    );
    const reader = stream.getReader();
    try {
        await vi.advanceTimersByTimeAsync(180_000);
        const socket = connector.sockets[0];
        const subscriptionId = socket?.subscriptionIds[0];
        if (socket === undefined || subscriptionId === undefined) {
            throw new Error("Expected the live subscription");
        }
        socket.dispatchEvent(
            new MessageEvent("message", {
                data: JSON.stringify({
                    kind: "session.events.event",
                    subscriptionId,
                    seqId: 1,
                    eventId: "event-1",
                    data: "event-after-idle",
                }),
            }),
        );
        await expect(reader.read()).resolves.toEqual({
            done: false,
            value: { seqId: 1, eventId: "event-1", data: "event-after-idle" },
        });
    } finally {
        transport.close();
        reader.releaseLock();
    }
});

it("Given a transport whose peer stops answering heartbeats, When the ten-second acknowledgement deadline expires, Then the stream fails and a subsequent request reconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const connector = new BrowserWebSocketConnector(0, "", "silent");
    const transport = new WsTransport({ connector });
    const stream = await transport.openSessionLiveEvents(
        runtimeRequest("https://relay.example.test/session/events-v2"),
    );
    const reader = stream.getReader();
    try {
        await vi.advanceTimersByTimeAsync(20_000);
        const failed = expect(reader.read()).rejects.toBeInstanceOf(MobiusConnectionError);
        await vi.advanceTimersByTimeAsync(10_000);
        await failed;
        expect((await transport.fetch(runtimeRequest("https://relay.example.test/after-recovery"))).status).toBe(204);
    } finally {
        transport.close();
        reader.releaseLock();
    }
});

it("Given a Unicode JSON request and response, When the browser uses the WebSocket transport, Then it transfers their text without Base64 wrapping", async () => {
    const responseBody = JSON.stringify({ message: "Olá, Mobius" });
    const connector = new BrowserWebSocketConnector(0, responseBody);
    const transport = new WsTransport({ connector });
    const requestBody = JSON.stringify({ prompt: "show café ☕" });

    const response = await transport.fetch(
        runtimeRequest("https://relay.example.test/mobius/api/v1/projects/project/sessions/session-1/turns", {
            body: requestBody,
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

    expect(connector.sockets[0]?.requestBodies).toEqual([requestBody]);
    expect(await response.text()).toBe(responseBody);
    transport.close();
});

it("Given an idle browser transport, When its connection expires, Then it closes cleanly and the next request reconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector, idleTimeoutMilliseconds: 1_000 });

    expect((await transport.fetch(runtimeRequest("https://relay.example.test/first"))).status).toBe(204);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connector.sockets[0]?.closedWith).toEqual({
        code: 4000,
        reason: "Mobius transport idle timeout",
    });
    expect((await transport.fetch(runtimeRequest("https://relay.example.test/second"))).status).toBe(204);
    expect(connector.sockets).toHaveLength(2);

    transport.close();
});

it("Given a replacement WebSocket carries a live subscription, When the old socket reports a delayed close, Then the replacement keeps delivering events", async () => {
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });

    expect((await transport.fetch(runtimeRequest("https://relay.example.test/first"))).status).toBe(204);
    const first = connector.sockets[0];
    if (first === undefined) {
        throw new Error("Expected the first WebSocket connection");
    }
    first.dispatchEvent(new Event("error"));
    expect((await transport.fetch(runtimeRequest("https://relay.example.test/second"))).status).toBe(204);
    const second = connector.sockets[1];
    if (second === undefined) {
        throw new Error("Expected the replacement WebSocket connection");
    }
    const events = await transport.openSessionLiveEvents(
        runtimeRequest("https://relay.example.test/mobius/api/v1/projects/project/sessions/session/events-v2"),
    );
    const subscriptionId = second.subscriptionIds[0];
    if (subscriptionId === undefined) {
        throw new Error("Expected a live event subscription");
    }

    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    second.dispatchEvent(
        new MessageEvent("message", {
            data: JSON.stringify({
                data: "event-data",
                eventId: "event-1",
                kind: "session.events.event",
                seqId: 1,
                subscriptionId,
            }),
        }),
    );

    expect(await events.getReader().read()).toEqual({
        done: false,
        value: { data: "event-data", eventId: "event-1", seqId: 1 },
    });
    expect(connector.sockets).toHaveLength(2);

    transport.close();
});

it("Given an idle Session stream and a brief network interruption, When connectivity returns within ten seconds, Then the SDK recovers the live subscription", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector(6);
    const transport = new WsTransport({ connector });
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(sessionCredential),
        endpoint: "https://relay.example.test",
        projectId: "project-1",
        transport,
    });
    const reconciliations: string[] = [];
    const controller = new AbortController();
    const subscription = await client.events.subscribeLive(
        "session-1",
        {
            receive: async () => true,
            reconcile: async (connection) => {
                reconciliations.push(connection.kind);
            },
        },
        controller.signal,
    );
    const completed = subscription.completed;
    void completed.catch(() => undefined);

    connector.sockets[0]?.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(connector.connectAttempts).toBe(8);
    expect(connector.sockets).toHaveLength(2);
    expect(reconciliations).toEqual(["initial", "reconnected"]);

    controller.abort();
    await completed;
    transport.close();
});

it("Given a live Session stream cannot reconnect, When its retry budget expires, Then the SDK exposes the sanitized transport reason", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector(1);
    const transport = new WsTransport({ connector });
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(sessionCredential),
        endpoint: "https://relay.example.test",
        maxStreamReconnectAttempts: 1,
        projectId: "project-1",
        transport,
    });
    const controller = new AbortController();
    const subscription = await client.events.subscribeLive(
        "session-1",
        { receive: async () => true, reconcile: async () => undefined },
        controller.signal,
    );

    connector.sockets[0]?.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(250);

    await expect(subscription.completed).rejects.toThrow(
        "The live session event stream could not recover. Cause: The Mobius WebSocket transport could not connect. Caused by: The controlled WebSocket reconnect failed because the network is unavailable",
    );
    transport.close();
});

it("Given caller-owned Session recovery, When its live stream disconnects, Then a zero retry budget reports the failure without waiting for an SDK backoff", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(sessionCredential),
        endpoint: "https://relay.example.test",
        maxStreamReconnectAttempts: 0,
        projectId: "project-1",
        transport,
    });
    try {
        const subscription = await client.events.subscribeLive(
            "session-1",
            { receive: async () => true, reconcile: async () => undefined },
            new AbortController().signal,
        );
        const failure = expect(subscription.completed).rejects.toThrow(
            "The live session event stream could not recover",
        );
        const socket = connector.sockets[0];
        if (socket === undefined) {
            throw new Error("Expected the connected relay socket");
        }
        socket.dispatchEvent(new Event("error"));
        await failure;
    } finally {
        client.close();
        transport.close();
    }
});

it("Given caller-owned Session recovery, When its live stream receives nothing past the transport idle deadline, Then the stream fails so the caller can reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector, idleTimeoutMilliseconds: 1_000 });
    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(sessionCredential),
        endpoint: "https://relay.example.test",
        maxStreamReconnectAttempts: 0,
        projectId: "project-1",
        transport,
    });
    try {
        const subscription = await client.events.subscribeLive(
            "session-1",
            { receive: async () => true, reconcile: async () => undefined },
            new AbortController().signal,
        );
        let outcome: unknown = "still subscribed";
        void subscription.completed.then(
            () => {
                outcome = "completed";
            },
            (cause: unknown) => {
                outcome = cause;
            },
        );

        await vi.advanceTimersByTimeAsync(1_000);

        expect(outcome).toBeInstanceOf(MobiusConnectionError);
    } finally {
        client.close();
        transport.close();
    }
});
