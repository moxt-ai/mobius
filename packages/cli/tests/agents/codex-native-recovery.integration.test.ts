import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a newly created real Codex Session, When Chat requests its V2 history before the first prompt, Then Runtime returns an empty replay without resuming the active Codex thread", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "UNUSED_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
        const sessionId = await prepareNewRealSession(peer, "codex");
        const requestId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId,
                sessionId,
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
            expect(decodeSessionHistoryPageLoaded(message)).toMatchObject({
                events: {
                    events: {
                        sessionGenerationId: expect.any(String),
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

test("Given a real Codex native Session, When the active prompt is cancelled with a follow-up queued, Then the retained Agent completes the queued prompt", async () => {
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
            const nativeId = await prepareNewRealSession(peer, "codex");
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
                        attachments: [],
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
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.failed" &&
                        event.payload.commandId === commandId
                    ) {
                        throw new Error(JSON.stringify(event));
                    }
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        text += event.payload.content.text;
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === commandId
                    ) {
                        expect(event.payload.commandId).toBe(commandId);
                        expect(event.sessionId).toBe(nativeId);
                        expect(event.payload.stopReason).toBe(reason);
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
                if (
                    decodeMessageKind(message) === SESSION_EVENT_KIND &&
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    )
                ) {
                    break;
                }
            }
            peer.send(encodeSessionCancelCommand({ kind: "session.cancel", commandId: active, sessionId: nativeId }));
            await finish(active, "cancelled");
            holdResponse = false;
            release.resolve();
            expect(await finish(queued, "end_turn")).toContain("NATIVE_RECOVERY_REPLY");
        });
    } finally {
        release.resolve();
    }
});
