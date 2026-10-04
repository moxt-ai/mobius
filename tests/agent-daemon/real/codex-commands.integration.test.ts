import { randomUUID } from "node:crypto";
import {
    decodeRecordedSessionEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../infra/codex.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

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
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if ("commandId" in event && event.commandId !== commandId) {
                    continue;
                }
                if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.kind === "agent.message.delta") {
                    text += event.text;
                }
                if (event.kind === "session.completed") {
                    expect(event.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toContain(prompt === "/compact" ? "Context compacted." : "REAL_COMPACT_REPLY");
        }
    });
});
