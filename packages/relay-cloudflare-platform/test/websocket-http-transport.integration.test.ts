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

class MultipleSubscriptionDaemonBoundary {
    readonly downstreams: WebSocket[] = [];

    readonly fetch = (_request: Request): Promise<Response> => {
        const pair = new WebSocketPair();
        pair[1].accept();
        this.downstreams.push(pair[1]);
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

class TextDaemonBoundary {
    requestBody: string | null = null;
    readonly responseBody: string;

    constructor(responseBody: string) {
        this.responseBody = responseBody;
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        this.requestBody = await request.text();
        return new Response(this.responseBody, { headers: { "content-type": "application/json" } });
    };
}

it("Given a Unicode JSON request and response, When the relay carries them over WebSocket, Then it transfers their text without Base64 wrapping", async () => {
    const requestBody = JSON.stringify({ prompt: "show café ☕" });
    const responseBody = JSON.stringify({ message: "Olá, Mobius" });
    const daemon = new TextDaemonBoundary(responseBody);
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
            body: requestBody,
            headers: [["content-type", "application/json"]],
            kind: "http.request",
            method: "POST",
            path: "/mobius/api/v1/projects/project/sessions",
            requestId: "text-body",
        }),
    );

    expect(JSON.parse(await message)).toEqual({
        body: responseBody,
        headers: [["content-type", "application/json"]],
        kind: "http.response",
        requestId: "text-body",
        status: 200,
    });
    expect(daemon.requestBody).toBe(requestBody);
    socket.close();
});

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

it("Given two live subscriptions, When each receives event batches, Then delivery sequence IDs start at one and advance per subscription", async () => {
    const daemon = new MultipleSubscriptionDaemonBoundary();
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
    for (const subscriptionId of ["subscription-1", "subscription-2"]) {
        const ready = nextMessage(socket);
        socket.send(
            JSON.stringify({
                headers: [],
                kind: "session.events.subscribe",
                path: `/mobius/api/v1/projects/project/sessions/${subscriptionId}/events-v2`,
                subscriptionId,
            }),
        );
        expect(JSON.parse(await ready)).toMatchObject({ kind: "session.events.ready", subscriptionId });
    }
    const first = daemon.downstreams[0];
    const second = daemon.downstreams[1];
    if (first === undefined || second === undefined) {
        throw new Error("Expected two downstream subscriptions");
    }

    let delivered = nextMessage(socket);
    first.send("first batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "first batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 1,
        subscriptionId: "subscription-1",
    });
    delivered = nextMessage(socket);
    first.send("second batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "second batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 2,
        subscriptionId: "subscription-1",
    });
    delivered = nextMessage(socket);
    second.send("independent batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "independent batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 1,
        subscriptionId: "subscription-2",
    });
    socket.close(1000, "Test complete");
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
        await vi.advanceTimersByTimeAsync(20_001);

        expect(JSON.parse(await heartbeat)).toEqual({
            kind: "session.events.heartbeat",
            subscriptionId: "subscription-1",
        });
        // The heartbeats keep re-arming the idle deadline, so the connection
        // outlives it even though the subscription itself stays quiet.
        await vi.advanceTimersByTimeAsync(40_000);
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
