import { randomUUID } from "node:crypto";

import {
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    type SessionLiveEventV3,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

function sendPrompt(peer: RealDaemonPeer, sessionId: string, commandId: string, prompt: string): void {
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "claude",
            bindingId: peer.bindingId,
            commandId,
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

async function nextLifecycle(
    peer: RealDaemonPeer,
    kind: "connected" | "idle" | "running",
): Promise<SessionLiveEventV3> {
    for (;;) {
        const event = await peer.nextLiveEventV3();
        if (event.item.sessionUpdate === "session_lifecycle_changed" && event.item.state.kind === kind) {
            return event;
        }
    }
}

test("Given a real Claude CLI and a prepared direct Session, When Claude answers, Then native content and lifecycle cross the public daemon protocol in sequence", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_V3_REPLY");
    await using agent = await ClaudeFixture.create(provider, { requireAdapter: false });
    await withRealDaemon(
        new ClaudeCodeAgentSpecification(),
        agent.environment,
        async (peer) => {
            const sessionId = await prepareNewRealSession(peer, "claude");
            const connected = await nextLifecycle(peer, "connected");
            const commandId = randomUUID();
            sendPrompt(peer, sessionId, commandId, "Answer through the direct Session");
            const running = await nextLifecycle(peer, "running");
            const events = [connected, running];
            let answer = "";
            let idle: SessionLiveEventV3 | null = null;
            while (idle === null) {
                const event = await peer.nextLiveEventV3();
                events.push(event);
                if (event.item.sessionUpdate === "agent_message_chunk" && event.item.content.type === "text") {
                    answer += event.item.content.text;
                } else if (
                    event.item.sessionUpdate === "session_lifecycle_changed" &&
                    event.item.state.kind === "idle"
                ) {
                    idle = event;
                }
            }
            expect(answer).toContain("CLAUDE_V3_REPLY");
            expect(events.map((event) => event.seq)).toEqual(
                Array.from({ length: idle.seq }, (_value, index) => index + 1),
            );
        },
        { nativeSessionV3: true },
    );
});

test("Given a real Claude CLI is waiting for provider output, When the direct turn is cancelled, Then the native query closes and the Session becomes idle", async () => {
    const providerStarted = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNREACHABLE_REPLY", {
        beforeFirstText: async () => {
            providerStarted.resolve();
            await releaseProvider.promise;
        },
    });
    try {
        await using agent = await ClaudeFixture.create(provider, { requireAdapter: false });
        await withRealDaemon(
            new ClaudeCodeAgentSpecification(),
            agent.environment,
            async (peer) => {
                const sessionId = await prepareNewRealSession(peer, "claude");
                await nextLifecycle(peer, "connected");
                const commandId = randomUUID();
                sendPrompt(peer, sessionId, commandId, "Wait until this turn is cancelled");
                const running = await nextLifecycle(peer, "running");
                await providerStarted.promise;
                peer.send(encodeSessionCancelCommand({ commandId, kind: "session.cancel", sessionId }));
                const events: SessionLiveEventV3[] = [];
                for (;;) {
                    const event = await peer.nextLiveEventV3();
                    events.push(event);
                    if (event.item.sessionUpdate === "session_lifecycle_changed" && event.item.state.kind === "idle") {
                        break;
                    }
                }
                expect(events.map((event) => event.seq)).toEqual(
                    Array.from(
                        { length: (events.at(-1)?.seq ?? running.seq) - running.seq },
                        (_value, index) => running.seq + index + 1,
                    ),
                );
            },
            { nativeSessionV3: true },
        );
    } finally {
        releaseProvider.resolve();
    }
});
