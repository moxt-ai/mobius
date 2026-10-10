import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventV2,
    decodeSessionLiveHistoryV2PageLoaded,
    encodeNativeSessionCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    type NativeSessionResult,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Codex saved more than 32 MiB of answers, When a user forks through the daemon, Then the copy opens, recent history is readable and a new prompt completes", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "Large saved answer. ".repeat(45_000));
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
        const sourceSessionId = await prepareNewRealSession(peer, "codex");
        expect(Buffer.byteLength(provider.response) * 40).toBeGreaterThan(32 * 1024 * 1024);
        for (let turn = 0; turn < 40; turn++) {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    sessionId: sourceSessionId,
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    images: [],
                    resources: [],
                    prompt: `Question ${turn}: answer without using tools`,
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                }),
            );
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (event.type !== "lifecycle-metadata") {
                    continue;
                }
                if (event.payload.kind !== "prompt.failed" && event.payload.kind !== "prompt.completed") {
                    continue;
                }
                if (event.payload.commandId !== commandId) {
                    continue;
                }
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
        }
        const identity = {
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: peer.bindingId,
            directoryId: "default",
            kind: "native.session.request",
            sessionId: sourceSessionId,
        } as const;
        const resultFor = async (requestId: string): Promise<NativeSessionResult> => {
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind !== "native.session.result") {
                    continue;
                }
                const result = decodeNativeSessionResult(message);
                if (result.requestId === requestId) {
                    return result;
                }
            }
        };
        const listId = randomUUID();
        peer.send(encodeNativeSessionCommand({ ...identity, action: "list", cursor: null, requestId: listId }));
        const directory = await resultFor(listId);
        if (directory.action !== "list") {
            throw new Error("Expected native directory");
        }
        const source = directory.entries.find((entry) => entry.mobiusSessionIds.includes(sourceSessionId));
        if (source === undefined) {
            throw new Error("Missing source conversation");
        }
        const forkId = randomUUID();
        const targetSessionId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "fork",
                entryId: source.entryId,
                targetSessionId,
                requestId: forkId,
            }),
        );
        const forked = await resultFor(forkId);
        expect(forked).toMatchObject({
            action: "fork",
            targetSessionId,
            ready: { restored: true, sessionId: targetSessionId },
        });
        const historyId = randomUUID();
        peer.send(
            encodeSessionLiveHistoryV2PageLoad({
                ...identity,
                kind: "session.live-history.v2.page.load",
                sessionId: targetSessionId,
                requestId: historyId,
                cursor: null,
                eventLimit: 10,
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
            const loaded = decodeSessionLiveHistoryV2PageLoaded(message);
            if (loaded.requestId !== historyId) {
                continue;
            }
            expect(loaded.events.events.nextCursor).not.toBeNull();
            expect(
                loaded.events.events.events.some(
                    (event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text" &&
                        event.payload.content.text.includes("Question 39"),
                ),
            ).toBe(true);
            break;
        }
        const continuedId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                ...identity,
                kind: "session.prompt",
                sessionId: targetSessionId,
                commandId: continuedId,
                prompt: "Continue this fork without using tools",
                images: [],
                resources: [],
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
        for (;;) {
            const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
            if (
                event.type !== "lifecycle-metadata" ||
                (event.payload.kind !== "prompt.failed" && event.payload.kind !== "prompt.completed") ||
                event.payload.commandId !== continuedId
            ) {
                continue;
            }
            expect(event.payload.kind).toBe("prompt.completed");
            break;
        }
    });
});
