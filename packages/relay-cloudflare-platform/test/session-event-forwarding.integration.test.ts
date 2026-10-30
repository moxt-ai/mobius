import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase, RuntimeRelay } from "@moxt-ai/mobius-relay-core";
import type { ProjectStorageDirectory } from "@moxt-ai/mobius-relay-core/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDurableObjectDependencies } from "../../relay-core/src/di/create-durable-object-dependencies.ts";
import { createPlatformDurableObjectContext } from "../src/durable-objects/platform-durable-object-context.ts";
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

interface RuntimeRelayTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly fetch: (request: Request) => Promise<Response>;
    /** Every socket the scenario opened, closed once it ends. */
    readonly sockets: WebSocket[];
}

async function connectRuntime(target: RuntimeRelayTarget, path: string): Promise<RuntimeConnection> {
    // This is the verified, Worker-to-Durable-Object HTTP boundary, not a public unauthenticated route.
    const response = await target.fetch(
        new Request(`https://runtime.internal/projects/${target.projectId}/${path}`, {
            headers: {
                Upgrade: "websocket",
                "x-mobius-channel-id": "wire-events-channel",
                "x-mobius-runtime-id": target.runtimeId,
                "x-mobius-host-credential-id": "ctl_close_notice",
            },
        }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected an upgraded Runtime connection");
    }
    const inbox = new Inbox(socket);
    target.sockets.push(socket);
    socket.accept();
    if (path === "daemon") {
        // The Relay attaches every daemon connection with liveness and announces when it is ready.
        expect(await inbox.next()).toEqual({ kind: "runtime.liveness.ready" });
    }
    return { inbox, socket };
}

async function withRuntimeRelay(scenario: (connect: (path: string) => Promise<RuntimeConnection>) => Promise<void>) {
    const runtimeId = `wire-events-${crypto.randomUUID()}`;
    const projectId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerRuntimeFixture(projectId, runtimeId);
    const relay = env.RUNTIME_RELAY.getByName(runtimeId);
    const sockets: WebSocket[] = [];
    const target = { projectId, runtimeId, fetch: (request: Request) => relay.fetch(request), sockets };
    const connect = (path: string) => connectRuntime(target, path);
    try {
        await scenario(connect);
    } finally {
        for (const socket of sockets) {
            socket.close(1000, "Test complete");
        }
    }
}

/** The Platform's Project directory, except that a scenario can hold one lookup to make an authorization read slow. */
class HeldProjectDirectory implements ProjectStorageDirectory {
    readonly #directory: ProjectStorageDirectory;
    #held: { readonly reached: PromiseWithResolvers<void>; readonly release: Promise<void> } | undefined;

    constructor(directory: ProjectStorageDirectory) {
        this.#directory = directory;
    }

    /** Holds the next lookup until `release` settles. Resolves once that lookup is waiting. */
    readonly holdNext = (release: Promise<void>): Promise<void> => {
        const reached = Promise.withResolvers<void>();
        this.#held = { reached, release };
        return reached.promise;
    };

    readonly resolve: ProjectStorageDirectory["resolve"] = async (projectId, signal) => {
        const held = this.#held;
        this.#held = undefined;
        if (held !== undefined) {
            held.reached.resolve();
            await held.release;
        }
        return await this.#directory.resolve(projectId, signal);
    };
}

interface HeldAuthorizationRelay {
    readonly connect: (path: string) => Promise<RuntimeConnection>;
    readonly directory: HeldProjectDirectory;
    /** Hands a daemon frame to the Relay's WebSocket handler. Settles once the Relay has handled it. */
    readonly receiveDaemonFrame: (message: unknown) => Promise<void>;
}

async function withHeldAuthorizationRelay(scenario: (relay: HeldAuthorizationRelay) => Promise<void>) {
    const runtimeId = `ordered-events-${crypto.randomUUID()}`;
    const projectId = `prj_ap_01_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await registerRuntimeFixture(projectId, runtimeId);
    await runInDurableObject(env.RUNTIME_RELAY.getByName(runtimeId), async (_instance, state) => {
        const database = new DurableObjectSqlDatabase(state.storage);
        const context = createPlatformDurableObjectContext(state, env, { database });
        const directory = new HeldProjectDirectory(context.storages.projectDirectory);
        const pending: Promise<void>[] = [];
        const relay = new RuntimeRelay(
            createDurableObjectDependencies({
                doDatabase: database,
                storages: { ...context.storages, projectDirectory: directory },
                gateways: { peers: context.gateways.peers, projectCredentials: context.gateways.projectCredentials },
                utilities: { waitUntil: (operation) => pending.push(operation) },
            }),
        );
        const sockets: WebSocket[] = [];
        const target = { projectId, runtimeId, fetch: (request: Request) => relay.fetch(request), sockets };
        const connect = (path: string) => connectRuntime(target, path);
        const receiveDaemonFrame = async (message: unknown): Promise<void> => {
            const [daemon] = state.getWebSockets("daemon");
            if (daemon === undefined) {
                throw new Error("Expected a connected daemon");
            }
            await relay.webSocketMessage(daemon, JSON.stringify(message));
        };
        try {
            await scenario({ connect, directory, receiveDaemonFrame });
        } finally {
            for (const socket of sockets) {
                socket.close(1000, "Test complete");
            }
            while (pending.length > 0) {
                await Promise.allSettled(pending.splice(0));
            }
        }
    });
}

it("Given a Session's final output in a mixed-Session batch, When the Session's completion arrives while that batch is still being authorized, Then the Session's browser receives the output before the completion", async () => {
    await withHeldAuthorizationRelay(async ({ connect, directory, receiveDaemonFrame }) => {
        await connect("daemon");
        const browser = await connect("host?sessionId=session-1");
        expect(await browser.inbox.next()).toMatchObject({ kind: "runtime.status", online: true });
        const event = (sessionId: string, position: string, type: string, payload: Record<string, unknown>) => ({
            eventId: `${sessionId}-${position}`,
            position,
            recordedAt: "2026-10-27T00:00:00.000Z",
            sessionGenerationId: "generation-1",
            sessionId,
            type,
            payload,
        });
        const finalOutput = event("session-1", "1", "acp", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Final answer" },
        });
        const otherOutput = event("session-2", "1", "acp", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Still working" },
        });
        const completion = event("session-1", "2", "lifecycle-metadata", {
            kind: "prompt.completed",
            commandId: "command-1",
            stopReason: "end_turn",
        });

        const release = Promise.withResolvers<void>();
        const held = directory.holdNext(release.promise);
        const mixedBatch = receiveDaemonFrame({ kind: "session.event.v2", events: [finalOutput, otherOutput] });
        await held;
        const completionBatch = receiveDaemonFrame({ kind: "session.event.v2", events: [completion] });
        // Admitting another browser reads the same Runtime authority after the completion's own read has started.
        // Releasing the held lookup only then means a Relay that lets frames overtake each other sends the
        // completion first.
        await connect("host");
        release.resolve();
        await Promise.all([mixedBatch, completionBatch]);

        expect(await browser.inbox.next()).toEqual({ kind: "session.event.v2", events: [finalOutput] });
        expect(await browser.inbox.next()).toEqual({ kind: "session.event.v2", events: [completion] });
    });
});

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
