import { randomUUID } from "node:crypto";
import {
    decodeRecordedSessionEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../infra/claude.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeAnthropicProvider } from "../providers/anthropic.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

test("Given the real claude and its production adapter, When two prompts execute through the daemon, Then a tool result and both streamed replies reach the client", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "REAL_CLAUDE_REPLY");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        for (const turn of [0, 1]) {
            const prompt =
                turn === 0 ? fakeProviderPrompts.successfulTool : "Continue the conversation with another reply";
            const commandId = randomUUID();
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
                    sessionId: peer.sessionId,
                    targetCommandId: "",
                }),
            );
            let text = "";
            let toolSucceeded = false;
            for (;;) {
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if (event.kind === "session.permission.requested") {
                    const option = event.options.find((entry) => entry.kind === "allow_once");
                    if (option === undefined) {
                        throw new Error("No one-time tool permission option");
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            sessionId: peer.sessionId,
                            interactionId: event.interactionId,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                } else if (event.kind === "agent.message.delta") {
                    expect(event.commandId).toBe(commandId);
                    text += event.text;
                } else if (event.kind === "agent.activity") {
                    if (event.activityType === "tool" && event.status === "completed") {
                        expect(event.output).toContain(peer.workspace);
                        toolSucceeded = true;
                    }
                } else if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                } else if (event.kind === "session.completed") {
                    expect(event.commandId).toBe(commandId);
                    expect(event.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toContain(provider.response);
            if (turn === 0) {
                expect(toolSucceeded).toBe(true);
            }
        }
    });
});

test.skipIf(process.platform !== "darwin")(
    "Given Claude Code receives a transient provider error, When its production adapter retries, Then the recoverable error reaches the client before the successful reply",
    async () => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_RECOVERED", {
            disconnectsBeforeSuccess: 1,
        });
        await using agent = await ClaudeFixture.create(provider);
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const commandId = randomUUID();
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
                    prompt: "Recover after a transient overload",
                    resources: [],
                    sessionId: peer.sessionId,
                    targetCommandId: "",
                }),
            );
            let notice = "";
            let text = "";
            for (;;) {
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if (event.kind === "agent.activity" && event.activityType === "notice") {
                    expect(event.commandId).toBe(commandId);
                    expect(event.status).toBe("completed");
                    notice = event.output;
                } else if (event.kind === "agent.message.delta") {
                    text += event.text;
                } else if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                } else if (event.kind === "session.completed") {
                    break;
                }
            }
            expect(notice.toLowerCase()).toContain("reconnecting");
            expect(text).toContain("CLAUDE_RECOVERED");
        });
    },
);
