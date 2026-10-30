import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    encodeNativeSessionResult,
    encodeSessionEventEnvelope,
    encodeSessionOperationFailedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, it } from "vitest";
import { registerRuntimeFixture } from "./registered-runtime.ts";

class Inbox {
    readonly received: Record<string, unknown>[] = [];
    readonly #pending: ((message: Record<string, unknown>) => void)[] = [];
    readonly #queued: Record<string, unknown>[] = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            this.received.push(message);
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending(message);
            }
        });
    }

    readonly next = (): Promise<Record<string, unknown>> => {
        const message = this.#queued.shift();
        return message === undefined ? new Promise((resolve) => this.#pending.push(resolve)) : Promise.resolve(message);
    };
}

// @no-uc: Runtime transport regression. HTTP native queries must not multiply live-event egress.
it("isolates native query replies from live fanout across hibernation and daemon disconnect", async () => {
    const runtimeId = `fanout-${crypto.randomUUID()}`;
    const projectId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerRuntimeFixture(projectId, runtimeId);
    const relay = env.RUNTIME_RELAY.getByName(runtimeId);
    const clients: WebSocket[] = [];
    const connect = async (path: string) => {
        // This is the verified, Worker-to-Durable-Object HTTP boundary, not a public unauthenticated route.
        const response = await relay.fetch(`https://runtime.internal/projects/${projectId}/${path}`, {
            headers: {
                Upgrade: "websocket",
                "x-mobius-channel-id": "fanout-channel",
                "x-mobius-runtime-id": runtimeId,
                "x-mobius-host-credential-id": "ctl_fanout",
            },
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected an upgraded Runtime connection");
        }
        const inbox = new Inbox(socket);
        clients.push(socket);
        socket.accept();
        return { socket, inbox };
    };
    try {
        const daemon = await connect("daemon");
        const viewer = await connect("host");
        expect(await viewer.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
        const sessionViewer = await connect("host?sessionId=session-7");
        expect(await sessionViewer.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
        const queries = await Promise.all(
            Array.from({ length: 16 }, async (_, index) => {
                const requestId = `query-${index}`;
                const connection = await connect(`host?nativeRequestId=${requestId}`);
                expect(await connection.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
                return { ...connection, requestId };
            }),
        );

        for (let index = 0; index < 25; index += 1) {
            daemon.socket.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `event-${index}`,
                            position: "1",
                            recordedAt: "2026-10-20T12:54:00.000Z",
                            sessionGenerationId: `generation-${index}`,
                            sessionId: `session-${index}`,
                            type: "acp",
                            payload: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "text", text: "x".repeat(64_000) },
                            },
                        },
                    ],
                }),
            );
        }
        for (let index = 0; index < 25; index += 1) {
            expect(await viewer.inbox.next()).toMatchObject({ kind: "session.event.v2" });
        }
        expect(await sessionViewer.inbox.next()).toMatchObject({ events: [{ sessionId: "session-7" }] });
        expect(sessionViewer.inbox.received.filter((message) => message["kind"] === "session.event.v2")).toHaveLength(
            1,
        );
        expect(
            queries.map(
                ({ inbox }) => inbox.received.filter((message) => message["kind"] === "session.event.v2").length,
            ),
        ).toEqual(Array(16).fill(0));

        for (const sessionId of ["session-8", "session-7"]) {
            daemon.socket.send(JSON.stringify({ kind: "session.status.changed", sessionId, status: { kind: "idle" } }));
            expect(await viewer.inbox.next()).toMatchObject({ kind: "session.status.changed", sessionId });
        }
        expect(await sessionViewer.inbox.next()).toMatchObject({
            kind: "session.status.changed",
            sessionId: "session-7",
        });

        await evictDurableObject(relay, { webSockets: "hibernate" });
        daemon.socket.send(
            encodeSessionEventEnvelope({
                kind: "session.event.v2",
                events: ["session-7", "session-8"].map((sessionId) => ({
                    sessionId,
                    eventId: `after-hibernation-${sessionId}`,
                    position: "2",
                    recordedAt: "2026-10-21T00:00:00.000Z",
                    sessionGenerationId: `generation-${sessionId}`,
                    type: "acp" as const,
                    payload: {
                        sessionUpdate: "agent_message_chunk" as const,
                        content: { type: "text" as const, text: "After hibernation" },
                    },
                })),
            }),
        );
        expect(await viewer.inbox.next()).toMatchObject({
            events: [{ sessionId: "session-7" }, { sessionId: "session-8" }],
        });
        expect(await sessionViewer.inbox.next()).toMatchObject({ events: [{ sessionId: "session-7" }] });
        const reply = (requestId: string) =>
            encodeNativeSessionResult({
                kind: "native.session.result",
                action: "active-turn",
                requestId,
                sessionId: "session-7",
                targetSessionId: "session-7",
                turn: null,
                queued: [],
                queuedCancellation: "before-start",
            });
        daemon.socket.send(reply("query-7"));
        expect(await queries[7]?.inbox.next()).toMatchObject({ kind: "native.session.result", requestId: "query-7" });
        expect(await viewer.inbox.next()).toMatchObject({ kind: "native.session.result", requestId: "query-7" });
        expect(
            queries.filter(({ requestId }) => requestId !== "query-7").map(({ inbox }) => inbox.received.length),
        ).toEqual(Array(15).fill(1));

        daemon.socket.send(
            encodeSessionOperationFailedEvent({
                kind: "session.operation.failed",
                requestId: "query-8",
                sessionId: "session-8",
                code: "native_session_busy",
                message: "Another native session operation is running",
            }),
        );
        expect(await viewer.inbox.next()).toMatchObject({ kind: "session.operation.failed", requestId: "query-8" });
        await expect
            .poll(() => queries[8]?.inbox.received.at(-1), { timeout: 1_000 })
            .toMatchObject({
                kind: "session.operation.failed",
                requestId: "query-8",
                code: "native_session_busy",
            });
        expect(await queries[8]?.inbox.next()).toMatchObject({ code: "native_session_busy" });

        queries[7]?.socket.close(1000, "Query complete");
        daemon.socket.send(reply("query-7"));
        expect(await viewer.inbox.next()).toMatchObject({ kind: "native.session.result", requestId: "query-7" });
        daemon.socket.close(1000, "Controlled daemon restart");
        expect(await viewer.inbox.next()).toMatchObject({ kind: "runtime.status", online: false });
        expect(await queries[0]?.inbox.next()).toMatchObject({ kind: "runtime.status", online: false });
    } finally {
        for (const socket of clients) {
            socket.close(1000, "Test complete");
        }
    }
});
