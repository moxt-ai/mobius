import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelopeV2,
    decodeSessionEventV2,
    decodeSessionReadyEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_EVENT_V2_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Pi has an active SDK turn, When the user steers it, Then Pi continues the same turn with the steering prompt", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    let responseNumber = 0;
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_STEERING_REPLY", {
        beforeFirstText: async () => {
            responseNumber += 1;
            if (responseNumber === 1) {
                activeEntered.resolve();
                await releaseActive.promise;
            }
        },
    });
    await using agent = await PiFixture.create(provider);
    try {
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const activeCommandId = randomUUID();
            const steeringCommandId = randomUUID();
            const sendPrompt = (
                commandId: string,
                prompt: string,
                disposition: "queue" | "reject",
                targetCommandId: string,
            ): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "pi",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition,
                        images: [],
                        kind: "session.prompt",
                        prompt,
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId,
                    }),
                );

            sendPrompt(
                activeCommandId,
                "Start the task and wait for updated instructions",
                SessionPromptDisposition.Reject,
                "",
            );
            await activeEntered.promise;
            sendPrompt(
                steeringCommandId,
                "Use the steering requirement in the same turn",
                SessionPromptDisposition.Queue,
                activeCommandId,
            );
            let steeringCompleted = false;
            for (;;) {
                const message = await peer.nextMessage();
                if (
                    decodeMessageKind(message) === SESSION_EVENT_V2_KIND &&
                    decodeSessionEventEnvelopeV2(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    )
                ) {
                    break;
                }
            }
            peer.send(
                encodeSessionPromptDispositionCommand({
                    commandId: steeringCommandId,
                    disposition: SessionPromptDisposition.Steer,
                    kind: "session.prompt.disposition",
                    sessionId: peer.sessionId,
                }),
            );

            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                for (const event of decodeSessionEventEnvelopeV2(message).events) {
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.failed" &&
                        event.payload.commandId === steeringCommandId
                    ) {
                        throw new Error(JSON.stringify(event));
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === steeringCommandId
                    ) {
                        expect(event.payload.stopReason).toBe("steered");
                        steeringCompleted = true;
                        releaseActive.resolve();
                    }
                }
                if (steeringCompleted) {
                    break;
                }
            }
            let text = "";
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.failed" &&
                    event.payload.commandId === activeCommandId
                ) {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === activeCommandId
                ) {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text.match(/REAL_PI_STEERING_REPLY/gu)).toHaveLength(2);
            expect(provider.diagnostics()).toHaveLength(2);
        });
    } finally {
        releaseActive.resolve();
    }
});

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
