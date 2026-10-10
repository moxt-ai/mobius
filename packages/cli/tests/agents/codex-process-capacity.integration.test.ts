import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventV2,
    decodeSessionLiveHistoryV2PageLoaded,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real Codex conversation, When more Sessions are opened than the daemon can retain, Then the original native Session continues with its history intact", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "RESTORED_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
        const identity = {
            agentId: "codex",
            bindingId: peer.bindingId,
            directoryId: "default",
            additionalDirectoryIds: [],
        };
        const create = async (): Promise<string> => await prepareNewRealSession(peer, "codex");
        const sessionId = await create();
        const prompt = async (text: string): Promise<void> => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    ...identity,
                    kind: "session.prompt",
                    commandId,
                    sessionId,
                    prompt: text,
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                    images: [],
                    resources: [],
                }),
            );
            let output = "";
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    output += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.sessionId).toBe(sessionId);
                    expect(event.payload.stopReason).toBe("end_turn");
                    expect(output).toContain("RESTORED_REPLY");
                    break;
                }
            }
        };
        await prompt("Original conversation before opening other Sessions");
        for (let index = 0; index < 11; index += 1) {
            await create();
        }
        await prompt("Continue the original conversation after opening other Sessions");
        peer.send(
            encodeSessionLiveHistoryV2PageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: randomUUID(),
                sessionId,
                cursor: null,
                eventLimit: 200,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "session.operation.failed") {
                throw new Error(message);
            }
            if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const page = decodeSessionLiveHistoryV2PageLoaded(message).events.events;
            const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            const userText = [
                ...new Set(
                    page.events.flatMap((event) => {
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.requested") {
                            return event.payload.content.flatMap((content) =>
                                content.type === "text" ? [content.text] : [],
                            );
                        }
                        return event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [];
                    }),
                ),
            ];
            expect(userText).toEqual([
                "Original conversation before opening other Sessions",
                "Continue the original conversation after opening other Sessions",
            ]);
            expect(updates.filter((update) => update.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
            break;
        }
    });
});
