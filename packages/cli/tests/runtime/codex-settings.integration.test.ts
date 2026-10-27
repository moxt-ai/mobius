import { randomUUID } from "node:crypto";
import { decodeSessionEvent, encodeSessionPromptCommand, SessionPromptDisposition } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent/specification/vendors/codex-agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

test("Given an owned Codex session, When Codex changes collaboration mode during a turn, Then the user receives the updated Plan selection before completion", async () => {
    await using codex = await ControlledCodexFixture.create();
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId: randomUUID(),
                sessionId: peer.sessionId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                attachments: [],
                prompt: "Enter Plan mode",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
                sessionConfigurations: [],
            }),
        );
        const selections: string[] = [];
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "config_option_update") {
                const option = event.payload.configOptions.find((option) => option.id === "collaboration_mode");
                if (option?.type === "select") {
                    selections.push(option.currentValue);
                }
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                break;
            }
        }
        expect(selections).toEqual(["plan"]);
    });
});
