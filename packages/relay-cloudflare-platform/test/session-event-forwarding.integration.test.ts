import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
    const relay = env.RUNTIME_RELAY.getByName(runtimeId);
    const sockets: WebSocket[] = [];
    const connect = async (path: string): Promise<RuntimeConnection> => {
        // This is the verified, Worker-to-Durable-Object HTTP boundary, not a public unauthenticated route.
        const response = await relay.fetch(`https://runtime.internal/projects/wire-events-project/${path}`, {
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
