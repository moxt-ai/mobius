import { acceptWebSocketHttpTransport, SessionRuntimeError } from "@moxt-ai/mobius-relay-core";
import { expect, it, vi } from "vitest";

class FailingDaemonBoundary {
    requests = 0;

    readonly fetch = (_request: Request): Promise<Response> => {
        this.requests += 1;
        return Promise.reject(
            new SessionRuntimeError("agent_execution_failed", "The local Agent exited before completing the request"),
        );
    };
}

function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        socket.addEventListener(
            "message",
            (event) => {
                if (typeof event.data !== "string") {
                    reject(new Error("Expected a text WebSocket message"));
                    return;
                }
                resolve(event.data);
            },
            { once: true },
        );
    });
}

class SubscriptionDaemonBoundary {
    requestSignal: AbortSignal | null = null;
    downstream: WebSocket | null = null;

    readonly fetch = (request: Request): Promise<Response> => {
        this.requestSignal = request.signal;
        const pair = new WebSocketPair();
        this.downstream = pair[1];
        pair[1].accept();
        return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
    };
}

class PendingDaemonBoundary {
    readonly response = Promise.withResolvers<Response>();
    readonly requested = Promise.withResolvers<AbortSignal>();

    readonly fetch = (request: Request): Promise<Response> => {
        this.requested.resolve(request.signal);
        return this.response.promise;
    };
}

it("Given a daemon request fails with a 5XX error, When the WebSocket transport reports it, Then the client receives its detailed code and message", async () => {
    const daemon = new FailingDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const message = nextMessage(socket);

    socket.send(
        JSON.stringify({
            body: "",
            headers: [],
            kind: "http.request",
            method: "GET",
            path: "/mobius/api/v1/events",
            requestId: "daemon-failure",
        }),
    );

    expect(JSON.parse(await message)).toEqual({
        code: "agent_execution_failed",
        kind: "http.error",
        message: "The local Agent exited before completing the request",
        requestId: "daemon-failure",
        status: 503,
    });
    expect(daemon.requests).toBe(1);
    socket.close();
});

it("Given an established event subscription, When the browser transport closes, Then the downstream socket closes without aborting its upgraded request", async () => {
    const daemon = new SubscriptionDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const ready = nextMessage(socket);
    socket.send(
        JSON.stringify({
            headers: [],
            kind: "session.events.subscribe",
            path: "/mobius/api/v1/projects/project/sessions/session/events-v2",
            subscriptionId: "subscription-1",
        }),
    );
    expect(JSON.parse(await ready)).toMatchObject({
        kind: "session.events.ready",
        subscriptionId: "subscription-1",
    });
    const downstream = daemon.downstream;
    const requestSignal = daemon.requestSignal;
    if (downstream === null || requestSignal === null) {
        throw new Error("Expected an established downstream subscription");
    }
    const closed = new Promise<void>((resolve) =>
        downstream.addEventListener("close", () => resolve(), { once: true }),
    );

    socket.close(1000, "Browser transport closed");

    await closed;
    expect(requestSignal.aborted).toBe(false);
});

it("Given an established event subscription is quiet, When the transport idle deadline passes, Then the browser remains connected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    try {
        const daemon = new SubscriptionDaemonBoundary();
        const response = acceptWebSocketHttpTransport(
            new Request("https://platform.test/mobius/api/v1/transport", {
                headers: { Upgrade: "websocket" },
            }),
            daemon.fetch,
        );
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected a WebSocket transport response");
        }
        socket.accept();
        const ready = nextMessage(socket);
        socket.send(
            JSON.stringify({
                headers: [],
                kind: "session.events.subscribe",
                path: "/mobius/api/v1/projects/project/sessions/session/events-v2",
                subscriptionId: "subscription-1",
            }),
        );
        expect(JSON.parse(await ready)).toMatchObject({
            kind: "session.events.ready",
            subscriptionId: "subscription-1",
        });

        const heartbeat = nextMessage(socket);
        await vi.advanceTimersByTimeAsync(60_001);

        expect(JSON.parse(await heartbeat)).toEqual({
            kind: "session.events.heartbeat",
            subscriptionId: "subscription-1",
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close(1000, "Test complete");
    } finally {
        vi.useRealTimers();
    }
});

it("Given a finite request is in flight, When the browser transport closes, Then the dispatched request can finish without disconnecting its downstream transport", async () => {
    const daemon = new PendingDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    socket.send(
        JSON.stringify({
            body: "",
            headers: [],
            kind: "http.request",
            method: "GET",
            path: "/mobius/api/v1/projects/project/runtimes/runtime/agents",
            requestId: "pending-request",
        }),
    );
    const requestSignal = await daemon.requested.promise;

    socket.close(1000, "Browser transport closed");
    daemon.response.resolve(Response.json({ agents: [] }));

    expect(requestSignal.aborted).toBe(false);
});
