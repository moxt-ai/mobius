import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRecordedSessionEvent,
    decodeSessionLiveHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionLiveHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
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
        const create = async (): Promise<string> => {
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    ...identity,
                    kind: "native.session.request",
                    action: "create",
                    requestId,
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.operation.failed") {
                    throw new Error(message);
                }
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    expect(result.requestId).toBe(requestId);
                    if (result.action !== "create") {
                        throw new Error("Expected created Session");
                    }
                    return result.nativeSessionId;
                }
            }
        };
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
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.kind === "agent.message.delta") {
                    output += event.text;
                }
                if (event.kind === "session.completed") {
                    expect(event.commandId).toBe(commandId);
                    expect(event.sessionId).toBe(sessionId);
                    expect(event.stopReason).toBe("end_turn");
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
            encodeSessionLiveHistoryPageLoad({
                ...identity,
                kind: "session.live-history.page.load",
                requestId: randomUUID(),
                sessionId,
                cursor: null,
                limit: 50,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "session.operation.failed") {
                throw new Error(message);
            }
            if (decodeMessageKind(message) !== "session.live-history.page.loaded") {
                continue;
            }
            const { page } = decodeSessionLiveHistoryPageLoaded(message);
            expect(page.status).toBe("available");
            if (page.status === "available") {
                expect(page.messages.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual([
                    "Original conversation before opening other Sessions",
                    "Continue the original conversation after opening other Sessions",
                ]);
                expect(page.messages.filter((entry) => entry.role === "assistant")).toHaveLength(2);
            }
            break;
        }
    });
});
