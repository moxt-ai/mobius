import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeRecordedSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionQueuedEvent,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Codex with an active turn, When three follow-ups are accepted and the middle one is cancelled, Then the remaining prompts execute in FIFO order without depending on the original turn", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "FIFO_REPLY", {
        beforeFirstText: async () => {
            entered.resolve();
            await release.promise;
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const active = randomUUID();
            const first = randomUUID();
            const cancelled = randomUUID();
            const last = randomUUID();
            const sendPrompt = (commandId: string, queued: boolean, target = active): void =>
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
                        prompt: `Reply to ${commandId}`,
                        disposition: queued ? SessionPromptDisposition.Queue : SessionPromptDisposition.Reject,
                        targetCommandId: queued ? target : "",
                    }),
                );
            sendPrompt(active, false);
            await entered.promise;
            for (const id of [first, cancelled, last]) {
                sendPrompt(id, true);
            }
            const accepted: string[] = [];
            while (accepted.length < 3) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.queued") {
                    accepted.push(decodeSessionQueuedEvent(message).commandId);
                }
            }
            // Authorization completes independently; acknowledgments need not arrive in execution order.
            expect(accepted).toEqual(expect.arrayContaining([first, cancelled, last]));
            peer.send(
                encodeSessionLiveHistoryV2PageLoad({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    cursor: null,
                    directoryId: "default",
                    eventLimit: 25,
                    kind: "session.live-history.v2.page.load",
                    requestId: randomUUID(),
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const executing = decodeSessionLiveHistoryV2PageLoaded(message).events.executingPromptRequest;
                expect(
                    executing?.events.flatMap((event) =>
                        event.type === "lifecycle-metadata" && event.payload.kind === "prompt.requested"
                            ? [event.payload.commandId]
                            : [],
                    ),
                ).toEqual([active, first, cancelled, last]);
                break;
            }
            peer.send(
                encodeSessionCancelCommand({ kind: "session.cancel", sessionId: peer.sessionId, commandId: cancelled }),
            );
            for (;;) {
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if (event.kind === "session.completed") {
                    expect(event.commandId).toBe(cancelled);
                    expect(event.stopReason).toBe("cancelled");
                    break;
                }
            }
            release.resolve();
            const started: string[] = [];
            const completed: string[] = [];
            const replies = new Map<string, string>();
            while (completed.length < 3) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event") {
                    continue;
                }
                const event = decodeRecordedSessionEvent(decodeSessionEventEnvelope(message).payload);
                if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.kind === "session.started") {
                    started.push(event.commandId);
                }
                if (event.kind === "agent.message.delta") {
                    replies.set(event.commandId, `${replies.get(event.commandId) ?? ""}${event.text}`);
                }
                if (event.kind === "session.completed") {
                    expect(event.stopReason).toBe("end_turn");
                    completed.push(event.commandId);
                }
            }
            expect(started).toEqual([first, last]);
            expect(completed).toEqual([active, first, last]);
            for (const id of completed) {
                expect(replies.get(id)).toContain("FIFO_REPLY");
            }
            const invalid = randomUUID();
            sendPrompt(invalid, true, invalid);
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.queued") {
                    expect(decodeSessionQueuedEvent(message).commandId).not.toBe(invalid);
                }
                if (decodeMessageKind(message) !== "session.event") {
                    continue;
                }
                const event = decodeRecordedSessionEvent(decodeSessionEventEnvelope(message).payload);
                if (event.kind === "session.failed") {
                    expect(event.commandId).toBe(invalid);
                    expect(event.code).toBe("prompt_queue_target_unavailable");
                    break;
                }
            }
            const late = randomUUID();
            sendPrompt(late, true);
            let acknowledged = false;
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.queued") {
                    expect(decodeSessionQueuedEvent(message).commandId).toBe(late);
                    acknowledged = true;
                }
                if (decodeMessageKind(message) !== "session.event") {
                    continue;
                }
                const event = decodeRecordedSessionEvent(decodeSessionEventEnvelope(message).payload);
                if (event.kind === "session.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.kind === "session.completed") {
                    expect(event.commandId).toBe(late);
                    expect(event.stopReason).toBe("end_turn");
                    expect(acknowledged).toBe(true);
                    break;
                }
            }
        });
    } finally {
        release.resolve();
    }
});
