import { randomUUID } from "node:crypto";
import {
    decodeRecordedSessionEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../infra/pi.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

test("Given the real pi and its production adapter, When two prompts execute through the daemon, Then a tool result and both streamed replies reach the client", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        for (const turn of [0, 1]) {
            const prompt =
                turn === 0 ? fakeProviderPrompts.successfulTool : "Continue the conversation with another reply";
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "pi",
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
                } else if (event.kind === "session.turn.updated") {
                    expect(event.turn.commandId).toBe(commandId);
                    text = event.turn.text;
                    for (const activity of event.turn.activities) {
                        if (activity.activityType === "tool" && activity.status === "completed") {
                            const output: unknown = JSON.parse(activity.output);
                            expect(output).toEqual(
                                expect.arrayContaining([
                                    expect.objectContaining({ type: "terminal", terminalId: expect.any(String) }),
                                ]),
                            );
                            toolSucceeded = true;
                        }
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
