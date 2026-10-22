import {
    decodeMessageKind,
    decodeSessionInfoUpdatedEvent,
    decodeSessionStatusChangedEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
    type SessionStatus,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test, vi } from "vitest";
import type { InProcessAcpEndpointFactory } from "../../src/acp/in-process/acp-endpoint.ts";
import { waitForSharedOperation } from "../../src/acp/runtime-operations.ts";
import { InProcessAcpAgentDefinition } from "../../src/runtime/agent-catalog/agent-specification.ts";
import { ControlledSessionAgent, type ControlledSessionEndpoint } from "../support/agents/controlled-session-agent.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";

// The production idle period spans a day. Relay heartbeats would time out
// while a fake clock skips that far, so these scenarios shrink the period
// through the daemon environment and stay inside one heartbeat deadline.
const IDLE_PERIOD_MILLISECONDS = 1_000;

/** Endpoint 0 serves discovery; each Agent process the daemon starts later gets the next index. */
class IdleSessionAgentSpecification extends InProcessAcpAgentDefinition {
    readonly agentExecutable = "node";
    readonly id = "controlled-idle";
    readonly label = "Controlled Idle";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createEndpoint: InProcessAcpEndpointFactory = this.sessions.createEndpoint;

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_IDLE_PATH");
    }
}

async function withIdleDaemon(
    specification: IdleSessionAgentSpecification,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
): Promise<void> {
    await withRealDaemon(
        specification,
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

async function waitForAgentProcessStop(peer: RealDaemonPeer, endpoint: ControlledSessionEndpoint): Promise<void> {
    await waitForSharedOperation(endpoint.terminated, peer.signal);
}

function nativeSessionOf(agent: ControlledSessionAgent): string {
    const created = agent.operations.find((operation) => operation.method === "session/new");
    if (created === undefined) {
        throw new Error("The Agent did not create a native Session");
    }
    return created.sessionId;
}

test("Given a Session without events or interaction for its idle period, When the period elapses, Then the daemon closes the Agent session and the next prompt resumes it", async () => {
    const specification = new IdleSessionAgentSpecification();
    const agent = specification.sessions;
    await withIdleDaemon(specification, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, specification.id);
        await prompt(peer, specification.id, sessionId, "first");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        await prompt(peer, specification.id, sessionId, "after the idle period");

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
    const specification = new IdleSessionAgentSpecification();
    const agent = specification.sessions;
    await withIdleDaemon(specification, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, specification.id);
        await prompt(peer, specification.id, sessionId, "first");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS / 2);
        await prompt(peer, specification.id, sessionId, "second");
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
    const specification = new IdleSessionAgentSpecification();
    const agent = specification.sessions;
    await withIdleDaemon(specification, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, specification.id);
        await prompt(peer, specification.id, sessionId, "first");
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
    const specification = new IdleSessionAgentSpecification();
    const agent = specification.sessions;
    await withIdleDaemon(specification, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, specification.id);
        const turn = agent.turns.hold();
        sendPrompt(peer, specification.id, sessionId, "keep working");
        await waitForStatus(peer, sessionId, "working");
        const nativeSessionId = nativeSessionOf(agent);

        await vi.advanceTimersByTimeAsync(2 * IDLE_PERIOD_MILLISECONDS);
        expect(agent.operations).toEqual([
            { endpoint: 1, method: "session/new", sessionId: nativeSessionId },
            { endpoint: 1, method: "session/prompt", sessionId: nativeSessionId },
        ]);

        turn.release();
        await waitForStatus(peer, sessionId, "idle");
        await vi.advanceTimersByTimeAsync(IDLE_PERIOD_MILLISECONDS - 1);
        expect(agent.operations.map((operation) => operation.method)).not.toContain("session/close");

        await vi.advanceTimersByTimeAsync(1);
        await waitForAgentProcessStop(peer, agent.endpoint(1));
        expect(agent.operations.at(-1)).toEqual({ endpoint: 1, method: "session/close", sessionId: nativeSessionId });
    });
});
