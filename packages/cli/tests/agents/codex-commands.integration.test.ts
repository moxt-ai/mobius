import { randomUUID } from "node:crypto";
import { decodeSessionEventV2, encodeSessionPromptCommand, SessionPromptDisposition } from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real Codex conversation, When the user compacts it and continues, Then the daemon completes both commands and the same conversation answers", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "REAL_COMPACT_REPLY");
    await using codex = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        for (const prompt of ["Hello", "/compact", "Continue after compaction"]) {
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
                    images: [],
                    resources: [],
                    prompt,
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                }),
            );
            let text = "";
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "lifecycle-metadata" &&
                    "commandId" in event.payload &&
                    event.payload.commandId !== commandId
                ) {
                    continue;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toContain(prompt === "/compact" ? "Context compacted." : "REAL_COMPACT_REPLY");
        }
    });
});
