import { SELF } from "cloudflare:test";
import { acceptWebSocketHttpTransport, SessionRuntimeError, standardWebSocketHost } from "@moxt-ai/mobius-relay-core";
import { encodeContentChunkFrame } from "@moxt-ai/mobius-sdk/protocol";
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

it("Given a browser connection, When it heartbeats through the public Platform transport, Then the Runtime acknowledges it and application requests remain usable", async () => {
    const response = await SELF.fetch(
        "https://platform.test/mobius/api/v1/projects/project/runtimes/runtime/transport",
        {
            headers: { Upgrade: "websocket" },
        },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const heartbeat = nextMessage(socket);
        socket.send('{"kind":"ping"}');
        expect(await heartbeat).toBe('{"kind":"pong"}');
        const result = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "after-heartbeat",
                method: "GET",
                path: "/mobius/api/v1/projects/project/runtimes/runtime/diagnostics",
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await result)).toMatchObject({
            kind: "http.response",
            requestId: "after-heartbeat",
            status: 401,
        });
    } finally {
        socket.close();
    }
});

it("Given a Runtime-bound browser, When it addresses another Runtime, Then the request is rejected without closing the browser connection", async () => {
    const response = await SELF.fetch(
        "https://platform.test/mobius/api/v1/projects/project/runtimes/runtime/transport",
        {
            headers: { Upgrade: "websocket" },
        },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const result = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "request-identity",
                method: "GET",
                path: "/mobius/api/v1/projects/project/runtimes/another-runtime/diagnostics",
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await result)).toMatchObject({
            kind: "http.error",
            code: "invalid_target",
            requestId: "request-identity",
            status: 400,
        });
        const heartbeat = nextMessage(socket);
        socket.send('{"kind":"ping"}');
        expect(await heartbeat).toBe('{"kind":"pong"}');
    } finally {
        socket.close();
    }
});

it("Given two browser connections to one Runtime, When their pending uploads exceed its shared budget, Then the second upload is refused and capacity is released after a failed transfer", async () => {
    const endpoint = "https://platform.test/mobius/api/v1/projects/upload-project/runtimes/upload-runtime/transport";
    const first = (await SELF.fetch(endpoint, { headers: { Upgrade: "websocket" } })).webSocket;
    const second = (await SELF.fetch(endpoint, { headers: { Upgrade: "websocket" } })).webSocket;
    if (first === null || second === null) {
        throw new Error("Expected browser transports");
    }
    first.accept();
    second.accept();
    const declaration = (requestId: string) =>
        JSON.stringify({
            kind: "http.request",
            requestId,
            method: "POST",
            path: "/mobius/api/v1/projects/upload-project/runtimes/upload-runtime/content",
            headers: [],
            body: "",
            bodyByteLength: 8 * 1024 * 1024,
        });
    try {
        first.send(declaration("first"));
        const admitted = nextMessage(first);
        first.send('{"kind":"ping"}');
        expect(await admitted).toBe('{"kind":"pong"}');
        const refused = nextMessage(second);
        second.send(declaration("second"));
        expect(JSON.parse(await refused)).toMatchObject({
            kind: "http.error",
            code: "request_capacity_exceeded",
            requestId: "second",
        });
        const failed = nextMessage(first);
        first.send(
            encodeContentChunkFrame({ requestId: "first", sequence: 1, bytes: new Uint8Array([1]) }).slice().buffer,
        );
        expect(JSON.parse(await failed)).toMatchObject({
            kind: "http.error",
            code: "invalid_message",
            requestId: "first",
        });
        second.send(declaration("retry"));
        const retried = nextMessage(second);
        second.send('{"kind":"ping"}');
        expect(await retried).toBe('{"kind":"pong"}');
    } finally {
        first.close();
        second.close();
    }
});

it.each([
    { name: "missing", authorization: null, code: "session_access_required" },
    { name: "malformed", authorization: "Bearer invalid-session-credential", code: "project_credential_invalid" },
])(
    "Given a $name Session credential, When the public event-stream upgrade crosses ProjectDO, Then it returns the authentication error without another public handoff",
    { timeout: 5_000 },
    async ({ authorization, code }) => {
        const headers = new Headers({ Upgrade: "websocket" });
        if (authorization !== null) {
            headers.set("Authorization", authorization);
        }
        const response = await SELF.fetch(
            "https://platform.test/mobius/api/v1/projects/prj_wn_01_ABCDEFGHIJKLMNOPQRSTUVWX/sessions/session-unauthorized/events-v2",
            { headers },
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code } });
    },
);

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

it("Given two quiet subscriptions, When multiple heartbeat intervals pass, Then one connection heartbeat suffices and both subscriptions still deliver", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const daemon = new MultipleSubscriptionDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
        standardWebSocketHost,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport");
    }
    socket.accept();
    try {
        for (const subscriptionId of ["first-stream", "second-stream"]) {
            const ready = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "session.events.subscribe",
                    subscriptionId,
                    path: "/mobius/api/v1/projects/project/sessions/session/events-v2",
                    headers: [],
                }),
            );
            expect(JSON.parse(await ready)).toEqual({
                kind: "session.events.ready",
                subscriptionId,
            });
        }
        for (let interval = 0; interval < 4; interval += 1) {
            const heartbeat = nextMessage(socket);
            await vi.advanceTimersByTimeAsync(20_000);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        }
        for (const [index, downstream] of daemon.downstreams.entries()) {
            const delivered = nextMessage(socket);
            downstream.send(`stream-${index}`);
            expect(JSON.parse(await delivered)).toMatchObject({
                kind: "session.events.event",
                data: `stream-${index}`,
                subscriptionId: index === 0 ? "first-stream" : "second-stream",
            });
        }
    } finally {
        socket.close();
        vi.useRealTimers();
    }
});

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
        standardWebSocketHost,
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

it("Given an invalid binary declaration, When the request ID is reused for a valid upload, Then validation happens before buffering", async () => {
    const daemon = new TextDaemonBoundary("uploaded");
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        daemon.fetch,
        standardWebSocketHost,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const invalid = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/outside/mobius",
            requestId: "reused-upload",
        }),
    );
    expect(JSON.parse(await invalid)).toMatchObject({ code: "invalid_target", requestId: "reused-upload" });

    const uploaded = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/mobius/api/v1/projects/project/sessions",
            requestId: "reused-upload",
        }),
    );
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "reused-upload", sequence: 0 }),
    );
    expect(JSON.parse(await uploaded)).toMatchObject({
        body: "uploaded",
        kind: "http.response",
        requestId: "reused-upload",
        status: 200,
    });
    expect(daemon.requestBody).toBe("x");
    socket.close();
});

it("Given a binary upload sends an invalid chunk, When it retries the same request ID, Then the failed buffer was released", async () => {
    const daemon = new TextDaemonBoundary("uploaded");
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        daemon.fetch,
        standardWebSocketHost,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const declaration = {
        body: "",
        bodyByteLength: 1,
        headers: [],
        kind: "http.request",
        method: "POST",
        path: "/mobius/api/v1/projects/project/sessions",
        requestId: "retry-upload",
    };
    const invalid = nextMessage(socket);
    socket.send(JSON.stringify(declaration));
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "retry-upload", sequence: 1 }),
    );
    expect(JSON.parse(await invalid)).toMatchObject({ code: "invalid_message", requestId: "retry-upload" });

    const uploaded = nextMessage(socket);
    socket.send(JSON.stringify(declaration));
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "retry-upload", sequence: 0 }),
    );
    expect(JSON.parse(await uploaded)).toMatchObject({ kind: "http.response", requestId: "retry-upload", status: 200 });
    socket.close();
});

it("Given an incomplete upload consumes the aggregate byte budget, When its deadline passes, Then capacity is released", async () => {
    vi.useFakeTimers();
    try {
        const daemon = new TextDaemonBoundary("uploaded");
        const response = acceptWebSocketHttpTransport(
            new Request("https://platform.test/mobius/api/v1/transport", { headers: { Upgrade: "websocket" } }),
            daemon.fetch,
            standardWebSocketHost,
        );
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected a WebSocket transport response");
        }
        socket.accept();
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 12_582_912,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/mobius/api/v1/projects/project/sessions",
                requestId: "abandoned-upload",
            }),
        );
        const overloaded = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/mobius/api/v1/projects/project/sessions",
                requestId: "next-upload",
            }),
        );
        expect(JSON.parse(await overloaded)).toMatchObject({
            code: "request_capacity_exceeded",
            requestId: "next-upload",
            status: 429,
        });

        const expired = nextMessage(socket);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(JSON.parse(await expired)).toMatchObject({
            code: "request_timeout",
            requestId: "abandoned-upload",
            status: 408,
        });

        const uploaded = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/mobius/api/v1/projects/project/sessions",
                requestId: "next-upload",
            }),
        );
        socket.send(
            encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "next-upload", sequence: 0 }),
        );
        expect(JSON.parse(await uploaded)).toMatchObject({
            kind: "http.response",
            requestId: "next-upload",
            status: 200,
        });
        socket.close();
    } finally {
        vi.useRealTimers();
    }
});

it("Given many incomplete binary uploads, When their count reaches the pending limit, Then another declaration is rejected", async () => {
    const daemon = new TextDaemonBoundary("unused");
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        daemon.fetch,
        standardWebSocketHost,
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    for (let index = 0; index < 16; index += 1) {
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/mobius/api/v1/projects/project/sessions",
                requestId: `pending-${index}`,
            }),
        );
    }
    const overloaded = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/mobius/api/v1/projects/project/sessions",
            requestId: "pending-overflow",
        }),
    );
    expect(JSON.parse(await overloaded)).toMatchObject({
        code: "request_capacity_exceeded",
        requestId: "pending-overflow",
        status: 429,
    });
    socket.close();
});

it("Given a daemon request fails with a 5XX error, When the WebSocket transport reports it, Then the client receives its detailed code and message", async () => {
    const daemon = new FailingDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
        standardWebSocketHost,
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
        standardWebSocketHost,
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
        standardWebSocketHost,
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
            standardWebSocketHost,
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

        for (let interval = 0; interval < 4; interval += 1) {
            const heartbeat = nextMessage(socket);
            await vi.advanceTimersByTimeAsync(20_000);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        }
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
        standardWebSocketHost,
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
