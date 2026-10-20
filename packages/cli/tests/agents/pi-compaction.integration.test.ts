import { randomUUID } from "node:crypto";
import { decodeSessionEvent, encodeSessionPromptCommand, SessionPromptDisposition } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given pi compacts the conversation, When the daemon relays the turn, Then the client receives the compaction lifecycle and the retained summary", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    // pi keeps the most recent `keepRecentTokens` tokens out of compaction
    // (default 20 000 — more than this whole session). Shrink it so a couple of
    // seeded turns leave something to summarize.
    await agent.overrideSettings({ compaction: { keepRecentTokens: 1 } });
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sendPrompt = (prompt: string): void => {
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "pi",
                    bindingId: peer.bindingId,
                    commandId: randomUUID(),
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
        };

        // Seed enough turns that pi considers the session worth compacting.
        for (const topic of ["archaeology", "bicycles", "coffee"]) {
            sendPrompt(`Talk about ${topic} with some detail`);
            for (;;) {
                const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata") {
                    if (event.payload.kind === "prompt.failed") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
            }
        }

        sendPrompt("/compact");
        const statuses: string[] = [];
        const compactionIds: string[] = [];
        const summaryText: string[] = [];
        const bannerTexts: string[] = [];
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata") {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    break;
                }
                continue;
            }
            const update = event.payload;
            if (update.sessionUpdate === "compaction_update") {
                compactionIds.push(update.compactionId);
                statuses.push(update.status);
            } else if (update.sessionUpdate === "compaction_summary_chunk") {
                compactionIds.push(update.compactionId);
                summaryText.push(update.content.type === "text" ? update.content.text : "");
            } else if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text" &&
                /compaction/iu.test(update.content.text)
            ) {
                bannerTexts.push(update.content.text);
            }
        }
        // The adapter-reported lifecycle: opened, streamed its summary chunk, and
        // settled, all addressed to one compaction ID — with no text banners.
        expect(statuses).toEqual(["in_progress", "completed"]);
        expect(new Set(compactionIds).size).toBe(1);
        expect(bannerTexts).toEqual([]);
        // pi returns the summary it retained from its compact RPC.
        expect(summaryText.join("").length).toBeGreaterThan(0);
    });
});
