import {
    type AgentApp,
    type AgentConnection,
    agent as createAgentApp,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import {
    decodeMessageKind,
    decodeSessionInfoUpdatedEvent,
    decodeSessionStatusChangedEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
    type SessionStatus,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointFactory,
} from "../../src/acp/in-process/acp-endpoint.ts";
import { waitForSharedOperation } from "../../src/acp/runtime-operations.ts";
import { InProcessAcpAgentDefinition } from "../../src/runtime/agent-catalog/agent-specification.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";

// The production idle period spans a day. Relay heartbeats would time out
// while a fake clock skips that far, so these scenarios shrink the period
// through the daemon environment and stay inside one heartbeat deadline.
const IDLE_PERIOD_MILLISECONDS = 1_000;

interface AgentOperation {
    readonly endpoint: number;
    readonly method: string;
    readonly sessionId: string;
}

/** One Agent process; records the Session requests it serves. */
class IdleSessionEndpoint implements InProcessAcpEndpoint {
    readonly #app: AgentApp;
    #connection: AgentConnection | null = null;
    readonly #termination = Promise.withResolvers<AcpEndpointTermination>();
    readonly terminated = this.#termination.promise;

    constructor(endpoint: number, agent: IdleSessionAgentSpecification) {
        const record = (method: string, sessionId: string): void => {
            agent.operations.push({ endpoint, method, sessionId });
        };
        this.#app = createAgentApp({ name: "controlled-idle-agent" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            .onRequest(methods.agent.initialize, () => ({
                agentCapabilities: {
                    loadSession: false,
                    promptCapabilities: { embeddedContext: false, image: false },
                    sessionCapabilities: { close: {}, resume: {} },
                },
                agentInfo: { name: "Controlled Idle Agent", version: "1.0.0" },
                authMethods: [],
                protocolVersion: PROTOCOL_VERSION,
            }))
            .onRequest(methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                record(methods.agent.session.new, sessionId);
                return { sessionId };
            })
            .onRequest(methods.agent.session.resume, (context) => {
                record(methods.agent.session.resume, context.params.sessionId);
                return {};
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                record(methods.agent.session.prompt, context.params.sessionId);
                await agent.turnsReleased();
                return { stopReason: "end_turn" as const };
            })
            .onRequest(methods.agent.session.close, (context) => {
                record(methods.agent.session.close, context.params.sessionId);
                return {};
            });
    }

    readonly app = (): AgentApp => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        this.#connection?.close();
        this.#termination.resolve({ kind: "closed" });
    };

    readonly reportTitle = async (sessionId: string, title: string): Promise<void> => {
        if (this.#connection === null) {
            throw new Error("The Agent endpoint is not connected");
        }
        await this.#connection.client.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "session_info_update", title },
        });
    };
}

/** Endpoint 0 serves discovery; each Agent process the daemon starts later gets the next index. */
class IdleSessionAgentSpecification extends InProcessAcpAgentDefinition {
    readonly agentExecutable = "node";
    readonly id = "controlled-idle";
    readonly label = "Controlled Idle";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly operations: AgentOperation[] = [];
    readonly #endpoints: IdleSessionEndpoint[] = [];
    #turns: Promise<void> = Promise.resolve();

    readonly createEndpoint: InProcessAcpEndpointFactory = () => {
        const endpoint = new IdleSessionEndpoint(this.#endpoints.length, this);
        this.#endpoints.push(endpoint);
        return endpoint;
    };

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_IDLE_PATH");
    }

    readonly endpoint = (index: number): IdleSessionEndpoint => {
        const endpoint = this.#endpoints[index];
        if (endpoint === undefined) {
            throw new Error(`Agent endpoint ${index.toString()} was never started`);
        }
        return endpoint;
    };

    readonly holdTurns = (): (() => void) => {
        const held = Promise.withResolvers<void>();
        this.#turns = held.promise;
        return held.resolve;
    };

    readonly turnsReleased = (): Promise<void> => this.#turns;
}

async function withIdleDaemon(
    agent: IdleSessionAgentSpecification,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
): Promise<void> {
    await withRealDaemon(
        agent,
        {
            MOBIUS_ACP_PROCESS_IDLE_SECONDS: (IDLE_PERIOD_MILLISECONDS / 1_000).toString(),
            MOBIUS_TEST_CONTROLLED_IDLE_PATH: process.execPath,
        },
        async (peer) => {
            vi.useFakeTimers({
                now: new Date("2026-10-21T00:00:00.000Z"),
                toFake: ["Date", "clearTimeout", "setTimeout"],
            });
            try {
                await scenario(peer);
            } finally {
                vi.useRealTimers();
            }
        },
    );
}

function sendPrompt(peer: RealDaemonPeer, agentId: string, sessionId: string, prompt: string): void {
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId,
            bindingId: peer.bindingId,
            commandId: crypto.randomUUID(),
            directoryId: "default",
            disposition: SessionPromptDisposition.Reject,
            images: [],
            kind: "session.prompt",
            prompt,
            resources: [],
            sessionId,
            targetCommandId: "",
        }),
    );
}

async function waitForStatus(peer: RealDaemonPeer, sessionId: string, kind: SessionStatus["kind"]): Promise<void> {
    for (;;) {
        const message = await peer.nextMessage();
        const messageKind = decodeMessageKind(message);
        if (messageKind === "session.operation.failed") {
            throw new Error(message);
        }
        if (messageKind !== "session.status.changed") {
            continue;
        }
        const event = decodeSessionStatusChangedEvent(message);
        if (event.sessionId === sessionId && event.status.kind === kind) {
            return;
        }
    }
}

async function prompt(peer: RealDaemonPeer, agentId: string, sessionId: string, text: string): Promise<void> {
    sendPrompt(peer, agentId, sessionId, text);
    await waitForStatus(peer, sessionId, "idle");
}

async function waitForTitle(peer: RealDaemonPeer, sessionId: string, title: string): Promise<void> {
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) !== "session.info.updated") {
            continue;
        }
        const event = decodeSessionInfoUpdatedEvent(message);
        if (event.sessionId === sessionId && event.title === title) {
            return;
        }
    }
}

async function waitForAgentProcessStop(peer: RealDaemonPeer, endpoint: IdleSessionEndpoint): Promise<void> {
    await waitForSharedOperation(endpoint.terminated, peer.signal);
}

function nativeSessionOf(agent: IdleSessionAgentSpecification): string {
    const created = agent.operations.find((operation) => operation.method === "session/new");
    if (created === undefined) {
        throw new Error("The Agent did not create a native Session");
    }
    return created.sessionId;
}

test("Given a Session without events or interaction for its idle period, When the period elapses, Then the daemon closes the Agent session and the next prompt resumes it", async () => {
    const agent = new IdleSessionAgentSpecification();
    await withIdleDaemon(agent, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, agent.id);
        await prompt(peer, agent.id, sessionId, "first");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        await prompt(peer, agent.id, sessionId, "after the idle period");

        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/close", sessionId: nativeSessionId },
            { endpoint: 2, method: "session/resume", sessionId: nativeSessionId },
            { endpoint: 2, method: "session/prompt", sessionId: nativeSessionId },
        ]);
    });
});

test("Given a prompt before a Session's idle period elapses, When the period passes after that prompt, Then the daemon closes the Agent session only then", async () => {
    const agent = new IdleSessionAgentSpecification();
    await withIdleDaemon(agent, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, agent.id);
        await prompt(peer, agent.id, sessionId, "first");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS / 2);
        await prompt(peer, agent.id, sessionId, "second");
        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        expect(agent.operations.at(-1)).toEqual({ endpoint: 1, method: "session/close", sessionId: nativeSessionId });
    });
});

test("Given the Agent reports a Session update before the idle period elapses, When the period passes after that update, Then the daemon closes the Agent session only then", async () => {
    const agent = new IdleSessionAgentSpecification();
    await withIdleDaemon(agent, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, agent.id);
        await prompt(peer, agent.id, sessionId, "first");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS / 2);
        await agent.endpoint(1).reportTitle(nativeSessionId, "Renamed by the Agent");
        await waitForTitle(peer, sessionId, "Renamed by the Agent");
        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        expect(agent.operations.at(-1)).toEqual({ endpoint: 1, method: "session/close", sessionId: nativeSessionId });
    });
});

test("Given a turn that is still running, When its idle period passes without events or interaction, Then the daemon keeps the Agent session until the period passes after the turn ends", async () => {
    const agent = new IdleSessionAgentSpecification();
    await withIdleDaemon(agent, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, agent.id);
        const releaseTurn = agent.holdTurns();
        sendPrompt(peer, agent.id, sessionId, "keep working");
        await waitForStatus(peer, sessionId, "working");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(2 * IDLE_PERIOD_MILLISECONDS);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        releaseTurn();
        await waitForStatus(peer, sessionId, "idle");
        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations.map((operation) => operation.method)).not.toContain("session/close");

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        expect(agent.operations.at(-1)).toEqual({ endpoint: 1, method: "session/close", sessionId: nativeSessionId });
    });
});
