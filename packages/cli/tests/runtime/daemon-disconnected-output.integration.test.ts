import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConnection, agent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
    WORKSPACE_ENTRIES_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { runRuntime } from "../../src/runtime/run.ts";
import {
    InProcessAcpAgentDefinition,
    type InProcessAcpEndpointFactory,
    RuntimeLocalContext,
} from "../../src/runtime.ts";
import { RuntimeTurnActivity } from "../../src/session/turn/runtime-turn-activity.ts";
import type { ScheduledTask, Timer } from "../../src/util/timer.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";

// Failure modes exercised through the production daemon and its real WebSocket transport:
// - a disconnect discards a batch whose delivery timer has not fired;
// - an Agent's final text and completion arrive while the Relay is disconnected;
// - a reconnect duplicates already sent text or reorders concurrent Sessions;
// - an offline burst violates frame limits or grows the pending output without a bound.
// The controlled ACP producer establishes transport recovery, not Agent compatibility.

class ManualTask implements ScheduledTask {
    #cancelled = false;
    readonly #callback: () => void;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (!this.#cancelled) {
            this.#cancelled = true;
            this.#callback();
        }
    };
}

class ManualTimer implements Timer {
    readonly #tasks = new Map<number, ManualTask[]>();
    readonly #waiters = new Map<number, Array<(task: ManualTask) => void>>();

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ManualTask(callback);
        const waiter = this.#waiters.get(milliseconds)?.shift();
        if (waiter !== undefined) {
            waiter(task);
        } else {
            const tasks = this.#tasks.get(milliseconds) ?? [];
            tasks.push(task);
            this.#tasks.set(milliseconds, tasks);
        }
        return task;
    };

    readonly next = (milliseconds: number): Promise<ManualTask> => {
        const task = this.#tasks.get(milliseconds)?.shift();
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve) => {
            const waiters = this.#waiters.get(milliseconds) ?? [];
            waiters.push(resolve);
            this.#waiters.set(milliseconds, waiters);
        });
    };
}

interface ControlledTurn {
    readonly finish: () => void;
    readonly write: (text: string) => Promise<void>;
}

class StreamingAgent {
    readonly #turns: ControlledTurn[] = [];
    readonly #waiters: Array<(turn: ControlledTurn) => void> = [];
    readonly #completions: Array<() => void> = [];

    readonly createEndpoint: InProcessAcpEndpointFactory = ({ onSessionUpdate }) => {
        const terminated = Promise.withResolvers<{ readonly kind: "closed" }>();
        let connection: AgentConnection | null = null;
        const app = agent({ name: "controlled-offline-output" })
            .onConnect((connected) => {
                connection = connected;
            })
            .onRequest(methods.agent.initialize, () => ({
                protocolVersion: PROTOCOL_VERSION,
                agentCapabilities: {},
                agentInfo: { name: "controlled-offline-output", version: "1.0.0" },
                authMethods: [],
            }))
            .onRequest(methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
            .onRequest(methods.agent.session.prompt, async (context) => {
                const completion = Promise.withResolvers<void>();
                this.#completions.push(completion.resolve);
                const turn: ControlledTurn = {
                    finish: completion.resolve,
                    write: async (text) =>
                        await onSessionUpdate({
                            sessionId: context.params.sessionId,
                            update: {
                                content: { type: "text", text },
                                messageId: context.params.sessionId,
                                sessionUpdate: "agent_message_chunk",
                            },
                        }),
                };
                const waiter = this.#waiters.shift();
                if (waiter === undefined) {
                    this.#turns.push(turn);
                } else {
                    waiter(turn);
                }
                await completion.promise;
                return { stopReason: "end_turn" };
            });
        return {
            app: () => app,
            terminated: terminated.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => {
                this.finishAll();
                connection?.close();
                terminated.resolve({ kind: "closed" });
            },
        };
    };

    readonly nextTurn = (): Promise<ControlledTurn> => {
        const turn = this.#turns.shift();
        return turn === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(turn);
    };

    readonly finishAll = (): void => {
        for (const finish of this.#completions) {
            finish();
        }
    };
}

class RelayPeer {
    readonly events: SessionLiveEvent[] = [];
    readonly batches: Array<{ readonly bytes: number; readonly count: number }> = [];
    readonly socket: WebSocket;
    readonly #messages: string[] = [];
    readonly #waiters: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        this.socket = socket;
        socket.on("message", (encoded) => {
            const text = encoded.toString();
            if (text === RUNTIME_HEARTBEAT_MESSAGE) {
                socket.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
                return;
            }
            if (decodeMessageKind(text) === SESSION_EVENT_KIND) {
                const envelope = decodeSessionEventEnvelope(text);
                this.events.push(...envelope.events);
                this.batches.push({ bytes: Buffer.byteLength(text), count: envelope.events.length });
            }
            const waiter = this.#waiters.shift();
            if (waiter === undefined) {
                this.#messages.push(text);
            } else {
                waiter(text);
            }
        });
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        return message === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(message);
    };

    readonly barrier = async (): Promise<void> => {
        this.socket.send(
            encodeWorkspaceListCommand({
                bindingId: "workspace",
                directoryId: "default",
                kind: "workspace.list",
                requestId: crypto.randomUUID(),
            }),
        );
        while (decodeMessageKind(await this.next()) !== WORKSPACE_ENTRIES_KIND) {
            // A response on the same ordered transport follows the reconnect flush.
        }
    };
}

function answer(events: readonly SessionLiveEvent[], sessionId: string): string {
    return events
        .filter((event) => event.sessionId === sessionId)
        .map((event) =>
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
                ? event.payload.content.text
                : "",
        )
        .join("");
}

async function startRuntime() {
    const directory = await mkdtemp(join(tmpdir(), "mobius-disconnected-output-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const http = createServer((request, response) => {
        request.resume();
        response.writeHead(request.method === "PUT" ? 204 : 404).end();
    });
    const relay = new WebSocketServer({ server: http });
    const peers: RelayPeer[] = [];
    const waiters: Array<(peer: RelayPeer) => void> = [];
    relay.on("connection", (socket) => {
        const peer = new RelayPeer(socket);
        const waiter = waiters.shift();
        if (waiter === undefined) {
            peers.push(peer);
        } else {
            waiter(peer);
        }
    });
    await listen(http);
    const timer = new ManualTimer();
    const producer = new StreamingAgent();
    const activity = new RuntimeTurnActivity();
    const config = createRuntimeConfig(
        {
            channelId: "disconnected-output",
            defaultWorkspace: workspace,
            relayUrl: new URL(`ws://127.0.0.1:${port(http).toString()}/daemon?token=${"r".repeat(43)}`),
        },
        [new InProcessAcpAgentDefinition("controlled", "Controlled Agent", process.execPath, producer.createEndpoint)],
        new RuntimeLocalContext(directory, {}),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal, timer, { turnActivity: activity });
    const nextPeer = (): Promise<RelayPeer> => {
        const peer = peers.shift();
        return peer === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(peer);
    };
    const initial = await nextPeer();
    await initial.barrier();
    return {
        activity,
        cancellation,
        initial,
        producer,
        timer,
        nextPeer,
        prompt: async (peer: RelayPeer, sessionId: string): Promise<ControlledTurn> => {
            peer.socket.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "controlled",
                    bindingId: config.bindingId,
                    commandId: `command-${sessionId}`,
                    directoryId: "default",
                    disposition: "reject",
                    images: [],
                    kind: "session.prompt",
                    prompt: "Finish the reply while the network is disconnected",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
            return await producer.nextTurn();
        },
        disconnect: async (peer: RelayPeer): Promise<ManualTask> => {
            const retry = timer.next(500);
            peer.socket.terminate();
            return await retry;
        },
        [Symbol.asyncDispose]: async () => {
            producer.finishAll();
            cancellation.abort();
            await runtime;
            for (const socket of relay.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:48:58.394Z"));
});

afterEach(() => vi.useRealTimers());

test.each([true, false])(
    "Given a reply prefix was flushed=%s, When the Agent finishes while disconnected, Then reconnection delivers the complete reply and completion exactly once",
    async (flushed) => {
        await using runtime = await startRuntime();
        const turn = await runtime.prompt(runtime.initial, "tail-session");
        const pending = await runtime.timer.next(100);
        if (flushed) {
            await turn.write("Reply prefix; ");
            pending.run();
            while (answer(runtime.initial.events, "tail-session") !== "Reply prefix; ") {
                await runtime.initial.next();
            }
        }
        const retry = await runtime.disconnect(runtime.initial);
        // A cancelled batching task must not discard events retained for reconnection.
        pending.run();
        if (!flushed) {
            await turn.write("Reply prefix; ");
        }
        await turn.write("the final 161 characters remain available.");
        turn.finish();
        using _idle = await runtime.activity.reserveWhenIdle(runtime.cancellation.signal);
        const reconnect = runtime.nextPeer();
        retry.run();
        const resumed = await reconnect;
        await resumed.barrier();
        const events = [...runtime.initial.events, ...resumed.events];
        expect(answer(events, "tail-session")).toBe("Reply prefix; the final 161 characters remain available.");
        expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
        expect(
            events.filter((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"),
        ).toMatchObject([
            { payload: { commandId: "command-tail-session", kind: "prompt.completed", stopReason: "end_turn" } },
        ]);
    },
);

test("Given concurrent Sessions produce an offline burst, When the Runtime reconnects, Then every event reaches the Relay in order within protocol frame limits", async () => {
    await using runtime = await startRuntime();
    const first = await runtime.prompt(runtime.initial, "burst-first");
    const second = await runtime.prompt(runtime.initial, "burst-second");
    (await runtime.timer.next(100)).run();
    await runtime.initial.barrier();
    const retry = await runtime.disconnect(runtime.initial);
    const expected: string[] = [];
    for (let index = 0; index < SESSION_EVENT_BATCH_MAX_SIZE + 2; index += 1) {
        const text = `${index.toString()};`;
        expected.push(text);
        await first.write(text);
    }
    const large = "\u00e9".repeat(250_000);
    for (let index = 0; index < 3; index += 1) {
        await second.write(large);
    }
    first.finish();
    second.finish();
    using _idle = await runtime.activity.reserveWhenIdle(runtime.cancellation.signal);
    const reconnect = runtime.nextPeer();
    retry.run();
    const resumed = await reconnect;
    await resumed.barrier();
    expect(answer(resumed.events, "burst-first")).toBe(expected.join(""));
    expect(answer(resumed.events, "burst-second")).toBe(large.repeat(3));
    expect(resumed.batches.length).toBeGreaterThan(1);
    expect(resumed.batches.every((batch) => batch.count <= SESSION_EVENT_BATCH_MAX_SIZE)).toBe(true);
    expect(resumed.batches.every((batch) => batch.bytes <= 1024 * 1024)).toBe(true);
    for (const sessionId of ["burst-first", "burst-second"]) {
        const positions = resumed.events
            .filter((event) => event.sessionId === sessionId)
            .map((event) => Number(event.position));
        expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
    expect(new Set(resumed.events.map((event) => event.eventId)).size).toBe(resumed.events.length);
    expect(
        resumed.events.filter(
            (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
        ),
    ).toHaveLength(2);
});

test("Given an outage exhausts the bounded output buffer, When the Relay reconnects, Then pending output stays bounded and the Agent can continue streaming", async () => {
    await using runtime = await startRuntime();
    const turn = await runtime.prompt(runtime.initial, "bounded-session");
    (await runtime.timer.next(100)).run();
    await runtime.initial.barrier();
    const retry = await runtime.disconnect(runtime.initial);
    const chunk = "x".repeat(512 * 1024);
    for (let index = 0; index < 70; index += 1) {
        await turn.write(chunk);
    }
    const reconnect = runtime.nextPeer();
    retry.run();
    const resumed = await reconnect;
    await resumed.barrier();
    const offlineAnswer = answer(resumed.events, "bounded-session");
    expect(offlineAnswer.length).toBeGreaterThan(0);
    expect(resumed.batches.reduce((bytes, batch) => bytes + batch.bytes, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
    await turn.write("streaming continues after the outage");
    turn.finish();
    using _idle = await runtime.activity.reserveWhenIdle(runtime.cancellation.signal);
    (await runtime.timer.next(100)).run();
    await resumed.barrier();
    expect(answer(resumed.events, "bounded-session")).toBe(`${offlineAnswer}streaming continues after the outage`);
    expect(
        resumed.events.filter(
            (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
        ),
    ).toMatchObject([{ payload: { kind: "prompt.completed", stopReason: "end_turn" } }]);
});
