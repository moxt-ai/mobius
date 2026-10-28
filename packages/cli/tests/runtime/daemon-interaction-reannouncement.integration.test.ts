import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AgentConnection,
    type AgentRequestContext,
    agent,
    methods,
    PROTOCOL_VERSION,
    type PromptRequest,
} from "@agentclientprotocol/sdk";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
    WORKSPACE_ENTRIES_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type { InProcessAcpEndpointFactory } from "../../src/engine/acp/agent/in-process-endpoint.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import type { ScheduledTask, Timer } from "../../src/engine/util/timer.ts";
import { ControlledEndpointConnection } from "../support/agents/controlled-endpoint-connection.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";

// A live event has no delivery acknowledgement, so the request an Agent waits on is lost when the
// connection that carried it fails right after. Nothing else tells the platform that the Agent is
// still waiting. The Runtime owns that fact, so every connection that becomes ready announces the
// requests still waiting for an answer, and the Relay, Recording and clients take a repeat for the
// request they already know. These scenarios run the production daemon over its real WebSocket
// transport; the controlled ACP producer establishes transport recovery, not Agent compatibility.

const BATCH_WINDOW_MILLISECONDS = 100;
const RETRY_DELAY_MILLISECONDS = 500;
const sessionId = "waiting-session";
const commandId = `command-${sessionId}`;

class ManualTask implements ScheduledTask {
    #cancelled = false;
    readonly #callback: () => void;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    get cancelled(): boolean {
        return this.#cancelled;
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

    /** Waits for the next task with this delay that is still due. */
    readonly next = async (milliseconds: number): Promise<ManualTask> => {
        for (;;) {
            const task =
                this.#tasks.get(milliseconds)?.shift() ??
                (await new Promise<ManualTask>((resolve) => {
                    const waiters = this.#waiters.get(milliseconds) ?? [];
                    waiters.push(resolve);
                    this.#waiters.set(milliseconds, waiters);
                }));
            if (!task.cancelled) {
                return task;
            }
        }
    };

    /** The oldest task with this delay that is still due, without waiting for one to be scheduled. */
    readonly due = (milliseconds: number): ManualTask | undefined => {
        const tasks = this.#tasks.get(milliseconds) ?? [];
        for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) {
            if (!task.cancelled) {
                return task;
            }
        }
        return undefined;
    };
}

type Ask = "permission" | "elicitation";

interface AgentBehavior {
    /** The Agent ends its Turn without waiting for the requests it made, once the scenario lets it. */
    readonly abandonRequests?: boolean;
    /**
     * The Agent ends its first Turn at once and keeps every later Turn running until the scenario ends
     * it, so a request it makes while no Turn runs can be followed by a new Turn.
     */
    readonly idleRequest?: boolean;
}

/** An Agent that asks for every listed answer in one Turn and ends the Turn once all are answered. */
class WaitingAgent {
    readonly #asks: readonly Ask[];
    readonly #behavior: AgentBehavior;
    readonly #outcomes = Promise.withResolvers<readonly string[]>();
    readonly #idleOutcome = Promise.withResolvers<string>();
    readonly #release = Promise.withResolvers<void>();
    #connection: AgentConnection | null = null;
    #nativeSessionId = "";
    #prompts = 0;

    constructor(asks: readonly Ask[], behavior: AgentBehavior) {
        this.#asks = asks;
        this.#behavior = behavior;
    }

    /** What the Agent received for each of its requests, in the order it asked. */
    readonly outcomes = (): Promise<readonly string[]> => this.#outcomes.promise;

    /** What the Agent received for the request it made while no Turn ran. */
    readonly idleOutcome = (): Promise<string> => this.#idleOutcome.promise;

    /** Lets an Agent that abandons its requests, or keeps a later Turn running, end the Turn. */
    readonly endTurn = (): void => this.#release.resolve();

    /** The Agent asks for permission while no Turn runs, the way background activity does. */
    readonly askWhileIdle = (): void => {
        const connection = this.#connection;
        if (connection === null) {
            throw new Error("The Agent is not connected");
        }
        void connection.client
            .request(methods.client.session.requestPermission, {
                options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-once" }],
                sessionId: this.#nativeSessionId,
                toolCall: {
                    kind: "execute",
                    status: "pending",
                    title: "Run a background command",
                    toolCallId: "idle-tool",
                    rawInput: { command: "pnpm test" },
                },
            })
            .then(
                (response) =>
                    this.#idleOutcome.resolve(
                        response.outcome.outcome === "selected" ? response.outcome.optionId : response.outcome.outcome,
                    ),
                (error: unknown) => this.#idleOutcome.reject(error),
            );
    };

    readonly #request = async (
        context: AgentRequestContext<PromptRequest>,
        ask: Ask,
        index: number,
    ): Promise<string> => {
        if (ask === "permission") {
            const response = await context.client.request(methods.client.session.requestPermission, {
                options: [
                    { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
                    { kind: "reject_once", name: "Reject", optionId: "reject" },
                ],
                sessionId: context.params.sessionId,
                toolCall: {
                    kind: "execute",
                    status: "pending",
                    title: `Run verification command ${index.toString()}`,
                    toolCallId: `permission-tool-${index.toString()}`,
                    rawInput: { command: "pnpm test" },
                },
            });
            return response.outcome.outcome === "selected" ? response.outcome.optionId : response.outcome.outcome;
        }
        const response = await context.client.request(methods.client.elicitation.create, {
            message: `Choose the branch to verify ${index.toString()}`,
            mode: "form",
            requestedSchema: {
                properties: { branch: { minLength: 1, title: "Branch", type: "string" } },
                required: ["branch"],
                type: "object",
            },
            sessionId: context.params.sessionId,
        });
        return response.action;
    };

    readonly createEndpoint: InProcessAcpEndpointFactory = () => {
        const terminated = Promise.withResolvers<{ readonly kind: "closed" }>();
        const app = agent({ name: "controlled-waiting-agent" })
            .onConnect((connected) => {
                this.#connection = connected;
            })
            .onRequest(methods.agent.initialize, () => ({
                protocolVersion: PROTOCOL_VERSION,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: "controlled-waiting-agent", version: "1.0.0" },
                authMethods: [],
            }))
            .onRequest(methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
            .onRequest(methods.agent.session.load, () => ({}))
            .onRequest(methods.agent.session.prompt, async (context) => {
                this.#nativeSessionId = context.params.sessionId;
                if (this.#behavior.idleRequest === true) {
                    this.#prompts += 1;
                    if (this.#prompts > 1) {
                        await this.#release.promise;
                    }
                    return { stopReason: "end_turn" };
                }
                const requests = this.#asks.map((ask, index) => this.#request(context, ask, index));
                if (this.#behavior.abandonRequests === true) {
                    for (const request of requests) {
                        request.catch(() => undefined);
                    }
                    await this.#release.promise;
                } else {
                    this.#outcomes.resolve(await Promise.all(requests));
                }
                return { stopReason: "end_turn" };
            });
        return {
            app: () => app,
            terminated: terminated.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => {
                this.#release.resolve();
                this.#connection?.close();
                terminated.resolve({ kind: "closed" });
            },
        };
    };
}

class RelayPeer {
    readonly events: SessionLiveEvent[] = [];
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
                this.events.push(...decodeSessionEventEnvelope(text).events);
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

    /** A response on the same ordered transport follows everything the Runtime sent before it. */
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
            // Output that arrived before the response is already recorded in `events`.
        }
    };
}

/** The requests an Agent is waiting on, as a client sees them announced. */
function announcedRequests(events: readonly SessionLiveEvent[]) {
    return events.flatMap((event) =>
        event.type === "lifecycle-metadata" &&
        (event.payload.kind === "session.permission.requested" ||
            event.payload.kind === "session.elicitation.requested")
            ? [{ event, request: event.payload.event }]
            : [],
    );
}

function resolvedInteractionIds(events: readonly SessionLiveEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === "lifecycle-metadata" &&
        (event.payload.kind === "session.permission.resolved" || event.payload.kind === "session.elicitation.resolved")
            ? [event.payload.event.interactionId]
            : [],
    );
}

function completedCommands(events: readonly SessionLiveEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"
            ? [event.payload.commandId]
            : [],
    );
}

function startedCommands(events: readonly SessionLiveEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started" ? [event.payload.commandId] : [],
    );
}

function answerCommand(ask: Ask, interactionId: string): string {
    return ask === "permission"
        ? encodeSessionPermissionRespondCommand({
              interactionId,
              kind: "session.permission.respond",
              optionId: "allow-once",
              outcome: "selected",
              sessionId,
          })
        : encodeSessionElicitationRespondCommand({
              action: "accept",
              content: JSON.stringify({ branch: "main" }),
              interactionId,
              kind: "session.elicitation.respond",
              sessionId,
          });
}

async function startRuntime(asks: readonly Ask[], behavior: AgentBehavior = {}) {
    const directory = await mkdtemp(join(tmpdir(), "mobius-interaction-reannouncement-"));
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
    const producer = new WaitingAgent(asks, behavior);
    const config = createRuntimeConfig(
        {
            channelId: "interaction-reannouncement",
            defaultWorkspace: workspace,
            relayUrl: new URL(`ws://127.0.0.1:${port(http).toString()}/daemon?token=${"r".repeat(43)}`),
        },
        [
            new AcpAgentDefinition(
                "controlled",
                "Controlled Agent",
                process.execPath,
                (options) =>
                    new ControlledEndpointConnection(
                        producer.createEndpoint({
                            ...options,
                            onSessionUpdate: options.client.onUpdate,
                        }),
                        options.client,
                    ),
            ),
        ],
        new RuntimeLocalContext(directory, {}),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal, timer);
    const nextPeer = (): Promise<RelayPeer> => {
        const peer = peers.shift();
        return peer === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(peer);
    };
    const initial = await nextPeer();
    await initial.barrier();
    /** Delivers every batch the Runtime has due for the peer, and returns once the peer has received them. */
    const deliver = async (peer: RelayPeer): Promise<void> => {
        await peer.barrier();
        for (
            let task = timer.due(BATCH_WINDOW_MILLISECONDS);
            task !== undefined;
            task = timer.due(BATCH_WINDOW_MILLISECONDS)
        ) {
            task.run();
            await peer.barrier();
        }
    };
    /** Delivers what the Runtime batches until the peer has seen what the scenario waits for. */
    const until = async (peer: RelayPeer, seen: () => boolean): Promise<void> => {
        while (!seen()) {
            (await timer.next(BATCH_WINDOW_MILLISECONDS)).run();
            await peer.barrier();
        }
    };
    return {
        initial,
        producer,
        deliver,
        until,
        prompt: (peer: RelayPeer, id: string = commandId): void => {
            peer.socket.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "controlled",
                    bindingId: config.bindingId,
                    commandId: id,
                    directoryId: "default",
                    disposition: "reject",
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Ask before continuing",
                    sessionId,
                    targetCommandId: "",
                }),
            );
        },
        /** Breaks the connection, lets the Runtime reconnect, and returns the new peer once the Runtime handled its readiness. */
        reconnect: async (peer: RelayPeer): Promise<RelayPeer> => {
            const retry = timer.next(RETRY_DELAY_MILLISECONDS);
            peer.socket.terminate();
            const next = nextPeer();
            (await retry).run();
            const resumed = await next;
            await resumed.barrier();
            return resumed;
        },
        [Symbol.asyncDispose]: async () => {
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
    vi.setSystemTime(new Date("2026-10-28T14:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

test.each(["permission", "elicitation"] as const)(
    "Given an Agent waits for a %s answer, When the Relay connection breaks and the Runtime reconnects, Then the same request is announced again once, the answer reaches the Agent, and an answered request is not announced on the next reconnect",
    async (ask) => {
        await using runtime = await startRuntime([ask]);
        runtime.prompt(runtime.initial);
        await runtime.until(runtime.initial, () => announcedRequests(runtime.initial.events).length === 1);
        const [original] = announcedRequests(runtime.initial.events);
        if (original === undefined) {
            throw new Error("The request was not announced on the first connection");
        }

        const resumed = await runtime.reconnect(runtime.initial);
        await runtime.deliver(resumed);
        const repeated = announcedRequests(resumed.events);
        expect(repeated).toHaveLength(1);
        expect(repeated[0]?.request).toEqual(original.request);
        expect(Number(repeated[0]?.event.position)).toBeGreaterThan(Number(original.event.position));

        resumed.socket.send(answerCommand(ask, original.request.interactionId));
        await runtime.until(resumed, () => resolvedInteractionIds(resumed.events).length === 1);
        expect(resolvedInteractionIds(resumed.events)).toEqual([original.request.interactionId]);
        expect(await runtime.producer.outcomes()).toEqual([ask === "permission" ? "allow-once" : "accept"]);

        const answered = await runtime.reconnect(resumed);
        await runtime.deliver(answered);
        expect(announcedRequests(answered.events)).toEqual([]);
    },
);

test("Given an Agent waits on two requests, When the Relay reconnects before and after one is answered, Then each connection announces only the requests still waiting, in the order they were asked", async () => {
    await using runtime = await startRuntime(["permission", "permission"]);
    runtime.prompt(runtime.initial);
    await runtime.until(runtime.initial, () => announcedRequests(runtime.initial.events).length === 2);
    const asked = announcedRequests(runtime.initial.events).map(({ request }) => request.interactionId);
    const [first, second] = asked;
    if (first === undefined || second === undefined) {
        throw new Error("Both requests must be announced on the first connection");
    }

    const resumed = await runtime.reconnect(runtime.initial);
    await runtime.deliver(resumed);
    expect(announcedRequests(resumed.events).map(({ request }) => request.interactionId)).toEqual(asked);

    resumed.socket.send(answerCommand("permission", first));
    await runtime.until(resumed, () => resolvedInteractionIds(resumed.events).includes(first));
    const again = await runtime.reconnect(resumed);
    await runtime.deliver(again);
    expect(announcedRequests(again.events).map(({ request }) => request.interactionId)).toEqual([second]);

    again.socket.send(answerCommand("permission", second));
    await runtime.until(again, () => resolvedInteractionIds(again.events).includes(second));
    expect(await runtime.producer.outcomes()).toEqual(["allow-once", "allow-once"]);
});

test("Given an Agent ended its Turn without waiting for a request it made, When the Relay reconnects, Then the request of the finished Turn is not announced again", async () => {
    await using runtime = await startRuntime(["permission"], { abandonRequests: true });
    runtime.prompt(runtime.initial);
    await runtime.until(runtime.initial, () => announcedRequests(runtime.initial.events).length === 1);
    runtime.producer.endTurn();
    await runtime.until(runtime.initial, () => completedCommands(runtime.initial.events).includes(commandId));

    const resumed = await runtime.reconnect(runtime.initial);
    await runtime.deliver(resumed);
    expect(announcedRequests(resumed.events)).toEqual([]);
});

test("Given an Agent asked for permission while no Turn ran and a new Turn started since, When the Relay reconnects, Then the request that still waits is announced again", async () => {
    await using runtime = await startRuntime([], { idleRequest: true });
    runtime.prompt(runtime.initial);
    await runtime.until(runtime.initial, () => completedCommands(runtime.initial.events).includes(commandId));
    runtime.producer.askWhileIdle();
    await runtime.until(runtime.initial, () => announcedRequests(runtime.initial.events).length === 1);
    const [idle] = announcedRequests(runtime.initial.events);
    if (idle === undefined) {
        throw new Error("The request was not announced on the first connection");
    }
    runtime.prompt(runtime.initial, "command-next");
    await runtime.until(runtime.initial, () => startedCommands(runtime.initial.events).includes("command-next"));

    const resumed = await runtime.reconnect(runtime.initial);
    await runtime.deliver(resumed);
    expect(announcedRequests(resumed.events).map(({ request }) => request.interactionId)).toEqual([
        idle.request.interactionId,
    ]);

    resumed.socket.send(answerCommand("permission", idle.request.interactionId));
    await runtime.until(resumed, () => resolvedInteractionIds(resumed.events).length === 1);
    expect(await runtime.producer.idleOutcome()).toBe("allow-once");
    runtime.producer.endTurn();
});
