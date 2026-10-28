import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRuntimeFixture } from "./registered-runtime.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

/** Messages a socket received, in order. Waiting fails once the Relay closes the socket. */
class Inbox {
    readonly #pending: PromiseWithResolvers<Record<string, unknown>>[] = [];
    readonly #queued: Record<string, unknown>[] = [];
    #closed: Error | undefined;

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", (event) => {
            this.#closed = new Error(`The Relay closed the connection: ${event.code} ${event.reason}`);
            for (const pending of this.#pending.splice(0)) {
                pending.reject(this.#closed);
            }
        });
    }

    readonly next = (): Promise<Record<string, unknown>> => {
        const message = this.#queued.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        if (this.#closed !== undefined) {
            return Promise.reject(this.#closed);
        }
        const pending = Promise.withResolvers<Record<string, unknown>>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

interface RuntimeConnection {
    readonly inbox: Inbox;
    readonly socket: WebSocket;
}

async function withRuntimeRelay(scenario: (connect: (path: string) => Promise<RuntimeConnection>) => Promise<void>) {
    const runtimeId = `wire-events-${crypto.randomUUID()}`;
    const projectId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerRuntimeFixture(projectId, runtimeId);
    const relay = env.RUNTIME_RELAY.getByName(runtimeId);
    const sockets: WebSocket[] = [];
    const connect = async (path: string): Promise<RuntimeConnection> => {
        // This is the verified, Worker-to-Durable-Object HTTP boundary, not a public unauthenticated route.
        const response = await relay.fetch(`https://runtime.internal/projects/${projectId}/${path}`, {
            headers: {
                Upgrade: "websocket",
                "x-mobius-channel-id": "wire-events-channel",
                "x-mobius-runtime-id": runtimeId,
                "x-mobius-host-credential-id": "ctl_close_notice",
            },
        });
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected an upgraded Runtime connection");
        }
        const inbox = new Inbox(socket);
        sockets.push(socket);
        socket.accept();
        return { inbox, socket };
    };
    try {
        await scenario(connect);
    } finally {
        for (const socket of sockets) {
            socket.close(1000, "Test complete");
        }
    }
}

it("Given independently versioned daemon content, When a mixed-session batch is relayed, Then each browser receives every field only for its subscribed sessions and the daemon stays connected", async () => {
    await withRuntimeRelay(async (connect) => {
        const daemon = await connect("daemon");
        const all = await connect("host");
        const selected = await connect("host?sessionId=session-1");
        expect(await all.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
        expect(await selected.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
        const events = ["session-2", "session-1"].map((sessionId) => ({
            eventId: `event-${sessionId}`,
            position: "1",
            recordedAt: "2026-10-27T00:00:00.000Z",
            sessionGenerationId: "generation-1",
            sessionId,
            type: "acp",
            futureEventField: { retained: true },
            payload: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
                status: "future_tool_status",
                futurePayloadField: { retained: true },
            },
        }));
        const envelope = { kind: "session.event.v2", events };
        daemon.socket.send(JSON.stringify(envelope));
        expect(await all.inbox.next()).toEqual(envelope);
        expect(await selected.inbox.next()).toEqual({
            ...envelope,
            events: events.filter((event) => event.sessionId === "session-1"),
        });

        // Retain the old V2 sender/reader representation independently of the SDK's current codecs.
        const legacy = {
            kind: "session.event.v2",
            events: [
                {
                    eventId: "old-event",
                    position: "2",
                    recordedAt: "2026-10-27T00:00:00.000Z",
                    sessionGenerationId: "generation-1",
                    sessionId: "session-1",
                    type: "acp",
                    payload: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Still connected" },
                    },
                },
            ],
        };
        daemon.socket.send(JSON.stringify(legacy));
        expect(await all.inbox.next()).toEqual(legacy);
        expect(await selected.inbox.next()).toEqual(legacy);
    });
});

it("Given future unroutable daemon variants, When the Relay receives them, Then it skips them and keeps forwarding known messages", async () => {
    await withRuntimeRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        expect(await host.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });

        for (const message of [
            { version: 3, message: { kind: "future" } },
            { kind: "future.runtime.event", value: true },
            { kind: "session.status.changed", sessionId: "", status: { kind: "future-status" } },
            {
                kind: "runtime.upgrade.result",
                requestId: "upgrade-1",
                version: "0.0.334",
                targetVersion: "0.0.335",
                outcome: { status: "future-outcome" },
            },
            {
                kind: "native.session.result",
                action: "future-action",
                requestId: "native-1",
                sessionId: "",
            },
        ]) {
            daemon.socket.send(JSON.stringify(message));
        }
        daemon.socket.send(new Uint8Array([255, 0, 3]));

        const status = { kind: "session.status.changed", sessionId: "session-1", status: { kind: "idle" } };
        daemon.socket.send(JSON.stringify(status));
        expect(await host.inbox.next()).toEqual(status);
        vi.setSystemTime(new Date("2026-10-27T00:01:00.000Z"));
        daemon.socket.send(JSON.stringify({ version: 4 }));
        daemon.socket.send(JSON.stringify(status));
        expect(await host.inbox.next()).toEqual(status);
    });
});

it("Given future fields and routable events, When peers use the Relay, Then their payloads survive and session filters remain enforced", async () => {
    await withRuntimeRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        const selected = await connect("host?sessionId=session-1");
        const sender = await connect("live-history");
        await sender.inbox.next();
        await host.inbox.next();
        await selected.inbox.next();
        const command = { kind: "runtime.ping", requestId: "ping-1", futureOptions: { format: 3 } };
        sender.socket.send(JSON.stringify(command));
        expect(await daemon.inbox.next()).toEqual(command);
        const reply = { kind: "runtime.pong", requestId: "ping-1", futureResult: { retained: true } };
        daemon.socket.send(JSON.stringify(reply));
        // Hosts also receive the control command broadcast before its reply.
        expect(await host.inbox.next()).toEqual(command);
        expect(await host.inbox.next()).toEqual(reply);
        const future = { kind: "session.future.changed", sessionId: "session-1", payload: { newFormat: [1, 2, 3] } };
        const otherSession = { ...future, sessionId: "session-2" };
        daemon.socket.send(JSON.stringify(otherSession));
        expect(await host.inbox.next()).toEqual(otherSession);
        daemon.socket.send(JSON.stringify(future));
        expect(await host.inbox.next()).toEqual(future);
        // Drain the runtime-wide control traffic for this subscriber.
        await selected.inbox.next();
        await selected.inbox.next();
        expect(await selected.inbox.next()).toEqual(future);
    });
});

it("Given a Session message with unknown variants and fields, When the Relay forwards it, Then the host receives the message unchanged", async () => {
    await withRuntimeRelay(async (connect) => {
        const daemon = await connect("daemon");
        const host = await connect("host");
        expect(await host.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });

        const message = {
            kind: "session.event.v2",
            futureEnvelopeField: { nested: [1, "two", null] },
            events: [
                {
                    eventId: "future-event-type",
                    position: "3",
                    recordedAt: "2026-10-27T00:00:00.000Z",
                    sessionGenerationId: "generation-1",
                    sessionId: "session-1",
                    type: "future-event",
                    futureEventField: { retained: true },
                    payload: {
                        futurePayloadField: { retained: true },
                        value: [false, 42, "opaque"],
                    },
                },
                {
                    eventId: "future-session-update",
                    position: "4",
                    recordedAt: "2026-10-27T00:00:00.000Z",
                    sessionGenerationId: "generation-1",
                    sessionId: "session-1",
                    type: "acp",
                    futureEventField: "retained",
                    payload: {
                        sessionUpdate: "future-session-update",
                        futurePayloadField: { retained: true },
                    },
                },
            ],
        };

        daemon.socket.send(JSON.stringify(message));
        expect(await host.inbox.next()).toEqual(message);
    });
});
