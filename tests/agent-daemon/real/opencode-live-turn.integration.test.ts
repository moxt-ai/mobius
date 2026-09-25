import { randomUUID } from "node:crypto";
import {
    decodeRecordedSessionEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { OpenCodeAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/opencode-agent.ts";
import { OpenCodeFixture } from "../infra/opencode.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

test("Given the real opencode and its production adapter, When two prompts execute through the daemon, Then a tool result and both streamed replies reach the client", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_OPENCODE_REPLY");
    await using agent = await OpenCodeFixture.create(provider);
    await withRealDaemon(new OpenCodeAgentSpecification(), agent.environment, async (peer) => {
        for (const turn of [0, 1]) {
            const prompt =
                turn === 0 ? fakeProviderPrompts.successfulTool : "Continue the conversation with another reply";
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "opencode",
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
