import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRecordedSessionEvent,
    decodeSessionLiveHistoryPageLoaded,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionQueuedEvent,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryPageLoad,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a newly created real Codex Session, When Chat requests its V2 history before the first prompt, Then Runtime returns an empty replay without resuming the active Codex thread", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "UNUSED_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
        const createRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                kind: "native.session.request",
                action: "create",
                requestId: createRequestId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                sessionId: peer.sessionId,
            }),
        );
        let sessionId = "";
        while (sessionId.length === 0) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "session.operation.failed") {
                throw new Error(message);
            }
            if (decodeMessageKind(message) === "native.session.result") {
                const result = decodeNativeSessionResult(message);
                if (result.action === "create") {
                    sessionId = result.nativeSessionId;
                }
            }
        }
        const requestId = randomUUID();
        peer.send(
            encodeSessionLiveHistoryV2PageLoad({
                kind: "session.live-history.v2.page.load",
                requestId,
                sessionId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                cursor: null,
                eventLimit: 50,
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
            expect(decodeSessionLiveHistoryV2PageLoaded(message)).toMatchObject({
                events: {
                    events: {
                        daemonGenerationId: expect.any(String),
                        events: [],
                        nextCursor: null,
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
                requestId,
                sessionId,
            });
            break;
        }
    });
});

test("Given a real codex native Session, When the active prompt is cancelled with a follow-up queued, Then the queued prompt restores that Session and completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdResponse = false;
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "NATIVE_RECOVERY_REPLY", {
        beforeFirstText: async () => {
            if (holdResponse) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using agent = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    kind: "native.session.request",
                    action: "create",
                    requestId,
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    sessionId: peer.sessionId,
                }),
            );
            let nativeId = "";
            while (nativeId.length === 0) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.operation.failed") {
                    throw new Error(message);
                }
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    expect(result.requestId).toBe(requestId);
                    if (result.action !== "create") {
                        throw new Error("Expected native Session creation");
                    }
                    nativeId = result.nativeSessionId;
                }
            }
            const sendPrompt = (commandId: string, targetCommandId = ""): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        sessionId: nativeId,
                        agentId: "codex",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        images: [],
                        resources: [],
                        prompt: "Reply with a short greeting, without using tools",
                        disposition:
                            targetCommandId.length > 0
                                ? SessionPromptDisposition.Queue
                                : SessionPromptDisposition.Reject,
                        targetCommandId,
                    }),
                );
            const finish = async (commandId: string, reason: string): Promise<string> => {
                let text = "";
                for (;;) {
                    const event = decodeRecordedSessionEvent(await peer.nextEvent());
                    if (event.kind === "session.failed") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.kind === "agent.message.delta" && event.commandId === commandId) {
                        text += event.text;
                    }
                    if (event.kind === "session.completed") {
                        expect(event.commandId).toBe(commandId);
                        expect(event.sessionId).toBe(nativeId);
                        expect(event.stopReason).toBe(reason);
                        return text;
                    }
                }
            };
            const initial = randomUUID();
            sendPrompt(initial);
            expect(await finish(initial, "end_turn")).toContain("NATIVE_RECOVERY_REPLY");
            holdResponse = true;
            const active = randomUUID();
            sendPrompt(active);
            // Model output is held; the real Agent and daemon remain in control of cancellation.
            await new Promise<void>((resolve, reject) => {
                const abort = (): void => reject(peer.signal.reason);
                peer.signal.addEventListener("abort", abort, { once: true });
                void entered.promise.then(() => {
                    peer.signal.removeEventListener("abort", abort);
                    resolve();
                });
            });
            const queued = randomUUID();
            sendPrompt(queued, active);
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.queued") {
                    expect(decodeSessionQueuedEvent(message).commandId).toBe(queued);
                    break;
                }
            }
            peer.send(encodeSessionCancelCommand({ kind: "session.cancel", commandId: active, sessionId: nativeId }));
            await finish(active, "cancelled");
            holdResponse = false;
            release.resolve();
            expect(await finish(queued, "end_turn")).toContain("NATIVE_RECOVERY_REPLY");
            peer.send(
                encodeSessionLiveHistoryPageLoad({
                    kind: "session.live-history.page.load",
                    requestId: randomUUID(),
                    sessionId: nativeId,
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: null,
                    limit: 50,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.page.loaded") {
                    continue;
                }
                const { page } = decodeSessionLiveHistoryPageLoaded(message);
                expect(page.status).toBe("available");
                if (page.status === "available") {
                    expect(page.messages).toContainEqual(
                        expect.objectContaining({ role: "assistant", outcome: "cancelled" }),
                    );
                }
                break;
            }
            const v2RequestId = randomUUID();
            peer.send(
                encodeSessionLiveHistoryV2PageLoad({
                    kind: "session.live-history.v2.page.load",
                    requestId: v2RequestId,
                    sessionId: nativeId,
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: null,
                    eventLimit: 100,
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
                const replay = decodeSessionLiveHistoryV2PageLoaded(message).events.events.events;
                const userText = replay.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                );
                const assistantText = replay.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                );
                expect(userText).toContain("Reply with a short greeting, without using tools");
                expect(assistantText.join("")).toContain("NATIVE_RECOVERY_REPLY");
                break;
            }
        });
    } finally {
        release.resolve();
    }
});
