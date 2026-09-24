import { type CommittedSessionEvent, encodeCommittedSessionEvent } from "@moxt-ai/mobius-protocol";
import { acceptWebSocketHttpTransport, SessionRuntimeError } from "@moxt-ai/mobius-relay-core";
import { expect, it } from "vitest";

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

it("Given a daemon request fails with a 5XX error, When the WebSocket transport reports it, Then the client receives its detailed code and message", async () => {
    const daemon = new FailingDaemonBoundary();
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        daemon.fetch,
        () => Promise.reject(new Error("The test does not subscribe to live events")),
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

it("Given a live Session subscription, When an event arrives, Then Platform sends it on the existing transport socket", async () => {
    const sessionEvent: CommittedSessionEvent = {
        eventId: "event-1",
        kind: "session.event.committed",
        payload: "{}",
        recordedAt: "2026-09-22T00:00:00.000Z",
        sessionId: "session-1",
        source: { kind: "runtime", sourceSeq: "1" },
    };
    const response = acceptWebSocketHttpTransport(
        new Request("https://platform.test/mobius/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        () => Promise.reject(new Error("Live events must not use HTTP dispatch for delivery")),
        async (request, receiver) => {
            expect(new URL(request.url).pathname).toBe(
                "/mobius/api/v1/projects/project-1/sessions/session-1/live-event-subscription-target",
            );
            await receiver.receive({ kind: "ready" });
            await receiver.receive({ event: sessionEvent, kind: "event" });
            return { unsubscribe: () => Promise.resolve() };
        },
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    socket.send(
        JSON.stringify({
            headers: [["authorization", "Bearer credential"]],
            kind: "session.events.subscribe",
            path: "/mobius/api/v1/projects/project-1/sessions/session-1/events",
            subscriptionId: "subscription-1",
        }),
    );

    await expect(nextMessage(socket).then(JSON.parse)).resolves.toEqual({
        kind: "session.events.ready",
        subscriptionId: "subscription-1",
    });
    await expect(nextMessage(socket).then(JSON.parse)).resolves.toEqual({
        data: encodeCommittedSessionEvent(sessionEvent),
        eventId: "event-1",
        kind: "session.events.event",
        subscriptionId: "subscription-1",
    });
    socket.close();
});
