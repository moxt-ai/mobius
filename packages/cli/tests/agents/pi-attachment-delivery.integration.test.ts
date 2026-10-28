import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { uploadPromptContent } from "../support/agents/upload-prompt-content.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Pi receives an embedded text attachment, When the turn runs, Then the attachment text reaches the model and the turn completes", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_ATTACHMENT_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        const attachment = await uploadPromptContent(peer, {
            bytes: new TextEncoder().encode(fakeProviderPrompts.successfulTool),
            kind: "resource",
            mediaType: "text/markdown",
            name: "instructions.md",
            uri: "attachment:///instructions.md",
        });
        peer.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "pi",
                bindingId: peer.bindingId,
                commandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                attachments: [attachment],
                kind: "session.prompt",
                // The visible prompt carries no tool trigger words; only the attachment does.
                prompt: "Follow the attached instructions",
                sessionId: peer.sessionId,
                targetCommandId: "",
            }),
        );
        let text = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                if (option === undefined) {
                    throw new Error("No one-time tool permission option");
                }
                peer.send(
                    encodeSessionPermissionRespondCommand({
                        kind: "session.permission.respond",
                        interactionId: event.payload.event.interactionId,
                        optionId: option.optionId,
                        outcome: "selected",
                        sessionId: peer.sessionId,
                    }),
                );
            } else if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                text += event.payload.content.text;
            } else if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
            ) {
                throw new Error(JSON.stringify(event));
            } else if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.stopReason).toBe("end_turn");
                break;
            }
        }
        // "tool result observed" is only produced when the model saw the attachment's
        // tool instructions, and the second request only happens after the tool ran.
        expect(text).toContain("PI_ATTACHMENT_REPLY");
        expect(text).toContain("tool result observed");
        expect(provider.diagnostics()).toHaveLength(2);
    });
});
