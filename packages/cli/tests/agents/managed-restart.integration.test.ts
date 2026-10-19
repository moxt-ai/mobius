import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEvent,
    decodeSessionHistoryPageLoaded,
    decodeSessionReadyEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent-catalog/agents/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

async function journey(peer: RealDaemonPeer, agentId: string, reply: string): Promise<void> {
    const sessionId = await prepareNewRealSession(peer, agentId);
    const identity = { agentId, bindingId: peer.bindingId, directoryId: "default", additionalDirectoryIds: [] };
    const prompt = "Remember this conversation across a daemon restart";
    const sendAndFinish = async (text: string): Promise<void> => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                ...identity,
                kind: "session.prompt",
                commandId,
                sessionId,
                images: [],
                resources: [],
                prompt: text,
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
        let output = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                output += event.payload.content.text;
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.stopReason).toBe("end_turn");
                expect(output).toContain(reply);
                return;
            }
        }
    };
    await sendAndFinish(prompt);
    await peer.restart();
    const requestId = randomUUID();
    peer.send(encodeSessionPrepareCommand({ ...identity, kind: "session.prepare", requestId, sessionId }));
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                expect(ready.restored).toBe(true);
                break;
            }
        }
    }
    const historyId = randomUUID();
    peer.send(
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId: historyId,
            sessionId,
            cursor: null,
            eventLimit: 50,
        }),
    );
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind !== "session.live-history.v2.page.loaded") {
            continue;
        }
        const history = decodeSessionHistoryPageLoaded(message);
        if (history.requestId !== historyId) {
            continue;
        }
        const text = history.events.events.events
            .flatMap((event) =>
                event.type === "acp" &&
                (event.payload.sessionUpdate === "user_message_chunk" ||
                    event.payload.sessionUpdate === "agent_message_chunk") &&
                event.payload.content.type === "text"
                    ? [event.payload.content.text]
                    : [],
            )
            .join("\n");
        expect(text).toContain(prompt);
        expect(text).toContain(reply);
        break;
    }
    await sendAndFinish("Continue the restored conversation");
}

test("Given a managed real Codex session, When the user quits and starts Mobius, Then history is restored and another turn completes", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-5.4", "MANAGED_CODEX_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(
        new CodexAgentSpecification(),
        agent.environment,
        (peer) => journey(peer, "codex", "MANAGED_CODEX_REPLY"),
        "managed",
    );
});

test("Given a managed real Claude Code session, When the user quits and starts Mobius, Then history is restored and another turn completes", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "MANAGED_CLAUDE_REPLY");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(
        new ClaudeCodeAgentSpecification(),
        agent.environment,
        (peer) => journey(peer, "claude", "MANAGED_CLAUDE_REPLY"),
        "managed",
    );
});

test("Given a managed real Pi session, When the user quits and starts Mobius, Then history is restored and another turn completes", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "MANAGED_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(
        new PiAgentSpecification(),
        agent.environment,
        (peer) => journey(peer, "pi", "MANAGED_PI_REPLY"),
        "managed",
    );
});
