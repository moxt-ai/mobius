import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventV2,
    decodeSessionReadyEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Pi only supports disabled thinking, When a session is prepared, Then the daemon omits the non-configurable Thinking control", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const requestId = randomUUID();
        peer.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "pi",
                bindingId: peer.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId,
                sessionId: peer.sessionId,
            }),
        );

        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.ready") {
                continue;
            }
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId !== requestId) {
                continue;
            }
            expect(ready.configOptions.filter((option) => option.category === "mode")).toEqual([]);
            expect(ready.configOptions.filter((option) => option.category === "thought_level")).toEqual([]);
            break;
        }
    });
});

test("Given real Pi without an external ACP adapter, When Bash executes through the daemon, Then the command and result are observable with both replies", async () => {
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
            let toolInput: unknown;
            let toolOutput: unknown;
            const toolContent = new Map<string, readonly unknown[]>();
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                    if (option === undefined) {
                        throw new Error("No one-time tool permission option");
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            sessionId: peer.sessionId,
                            interactionId: event.payload.event.interactionId,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                } else if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                } else if (
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
                ) {
                    if (event.payload.rawInput !== undefined) {
                        toolInput = event.payload.rawInput;
                    }
                    if (event.payload.rawOutput !== undefined) {
                        toolOutput = event.payload.rawOutput;
                    }
                    if (event.payload.content != null) {
                        toolContent.set(event.payload.toolCallId, event.payload.content);
                    }
                    if (event.payload.status === "completed") {
                        expect(toolInput).toEqual(expect.objectContaining({ command: "pwd" }));
                        expect(JSON.stringify(toolContent.get(event.payload.toolCallId))).toContain(peer.workspace);
                        expect(JSON.stringify(toolOutput)).toContain(peer.workspace);
                        toolSucceeded = true;
                    }
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.payload.stopReason).toBe("end_turn");
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
