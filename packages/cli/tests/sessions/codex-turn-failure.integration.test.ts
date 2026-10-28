import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

// @no-uc: Technical regression; Codex turn failures preserve the reason and user-message identity at the daemon boundary.
test("Given Codex accepts a prompt and then fails the turn with a reason, When the daemon reports the failure, Then the user receives that reason after Codex identified their message", async () => {
    const reason = "You've hit your usage limit. Try again later.";
    await using codex = await ControlledCodexFixture.create({ failTurnWith: reason });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                sessionId: peer.sessionId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                attachments: [],
                prompt: "Do the work",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
                sessionConfigurations: [],
            }),
        );
        const userMessageIdentities: Array<string | null | undefined> = [];
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                userMessageIdentities.push(event.payload.messageId);
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                throw new Error("The turn must fail, not complete");
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                expect(event.payload).toMatchObject({
                    commandId,
                    code: "acp_agent_error",
                    message: `Internal error: ${reason}`,
                });
                break;
            }
        }
        // The generic fallback only applies once Codex has identified the user's message, so the
        // identity must have reached the user before the failure for this scenario to exercise it.
        expect(userMessageIdentities).toEqual(["controlled-user-1"]);
    });
});
