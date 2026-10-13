import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelopeV2,
    decodeSessionEventV2,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionQueuedEvent,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Codex has accepted a steering prompt, When V2 recovery reloads the working Session, Then the steered user message remains visible", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "STEERED_REPLY", {
        beforeFirstText: async () => {
            activeEntered.resolve();
            await releaseActive.promise;
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const activeCommandId = randomUUID();
            const steeringCommandId = randomUUID();
            const steeringPrompt = "Use the recovered steering requirement";
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    commandId: activeCommandId,
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    images: [],
                    kind: "session.prompt",
                    prompt: "Use two shell tools successfully, then reply STEERED_REPLY",
                    resources: [],
                    sessionId: peer.sessionId,
                    targetCommandId: "",
                }),
            );
            await activeEntered.promise;
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: peer.bindingId,
                    commandId: steeringCommandId,
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Queue,
                    images: [],
                    kind: "session.prompt",
                    prompt: steeringPrompt,
                    resources: [],
                    sessionId: peer.sessionId,
                    targetCommandId: activeCommandId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (
                    decodeMessageKind(message) === "session.queued" &&
                    decodeSessionQueuedEvent(message).commandId === steeringCommandId
                ) {
                    break;
                }
            }
            peer.send(
                encodeSessionPromptDispositionCommand({
                    commandId: steeringCommandId,
                    disposition: SessionPromptDisposition.Steer,
                    kind: "session.prompt.disposition",
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                if (
                    decodeSessionEventEnvelopeV2(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.requested" &&
                            event.payload.content.some(
                                (content) => content.type === "text" && content.text === steeringPrompt,
                            ),
                    )
                ) {
                    break;
                }
            }
            const requestId = randomUUID();
            peer.send(
                encodeSessionLiveHistoryV2PageLoad({
                    cursor: null,
                    eventLimit: 50,
                    kind: "session.live-history.v2.page.load",
                    requestId,
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const recovered = decodeSessionLiveHistoryV2PageLoaded(message);
                if (recovered.requestId !== requestId) {
                    continue;
                }
                expect(
                    recovered.events.events.events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.requested" &&
                            event.payload.content.some(
                                (content) => content.type === "text" && content.text === steeringPrompt,
                            ),
                    ),
                ).toBe(true);
                break;
            }
        });
    } finally {
        releaseActive.resolve();
    }
});

test("Given real Codex advances between repeated prompts, When V2 recovery paginates the active stream, Then every ACP update remains ordered without reconciliation", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const queuedEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    const releaseQueued = Promise.withResolvers<void>();
    let responseNumber = 0;
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "BOUNDARY_REPLY", {
        beforeFirstText: async () => {
            responseNumber += 1;
            if (responseNumber === 1) {
                activeEntered.resolve();
                await releaseActive.promise;
            } else if (responseNumber === 2) {
                queuedEntered.resolve();
                await releaseQueued.promise;
            }
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const active = randomUUID();
            const queued = randomUUID();
            const repeatedPrompt = "Use two shell tools successfully, then reply BOUNDARY_REPLY";
            const prompt = (
                commandId: string,
                disposition: "queue" | "reject",
                targetCommandId: string,
                text = `Reply to ${commandId}`,
            ): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition,
                        images: [],
                        kind: "session.prompt",
                        prompt: text,
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId,
                    }),
                );

            prompt(active, SessionPromptDisposition.Reject, "", repeatedPrompt);
            await activeEntered.promise;
            prompt(queued, SessionPromptDisposition.Queue, active, repeatedPrompt);
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "session.queued") {
                    expect(decodeSessionQueuedEvent(message).commandId).toBe(queued);
                    break;
                }
            }

            releaseActive.resolve();
            await queuedEntered.promise;
            const requestId = randomUUID();
            peer.send(
                encodeSessionLiveHistoryV2PageLoad({
                    cursor: null,
                    eventLimit: 1,
                    kind: "session.live-history.v2.page.load",
                    requestId,
                    sessionId: peer.sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const result = decodeSessionLiveHistoryV2PageLoaded(message);
                if (result.requestId !== requestId) {
                    continue;
                }
                expect(result.events.queuedPromptRequests).toEqual([]);
                const sessionGenerationId = result.events.events.sessionGenerationId;
                const historyEvents = [...result.events.events.events];
                let cursor = result.events.events.nextCursor;
                while (cursor !== null) {
                    const olderRequestId = randomUUID();
                    peer.send(
                        encodeSessionLiveHistoryV2PageLoad({
                            cursor,
                            eventLimit: 1,
                            kind: "session.live-history.v2.page.load",
                            requestId: olderRequestId,
                            sessionId: peer.sessionId,
                        }),
                    );
                    for (;;) {
                        const olderMessage = await peer.nextMessage();
                        if (decodeMessageKind(olderMessage) !== "session.live-history.v2.page.loaded") {
                            continue;
                        }
                        const older = decodeSessionLiveHistoryV2PageLoaded(olderMessage);
                        if (older.requestId !== olderRequestId) {
                            continue;
                        }
                        expect(older.events.events.sessionGenerationId).toBe(sessionGenerationId);
                        historyEvents.unshift(...older.events.events.events);
                        cursor = older.events.events.nextCursor;
                        break;
                    }
                }
                expect(
                    historyEvents.filter(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.requested" &&
                            event.payload.content.some(
                                (content) => content.type === "text" && content.text === repeatedPrompt,
                            ),
                    ),
                ).toHaveLength(2);
                expect(
                    historyEvents.find(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.requested" &&
                            event.payload.commandId === queued,
                    ),
                ).toMatchObject({
                    payload: {
                        disposition: SessionPromptDisposition.Queue,
                        targetCommandId: active,
                    },
                });
                expect(
                    historyEvents.filter(
                        (event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text" &&
                            event.payload.content.text === repeatedPrompt,
                    ),
                ).toHaveLength(0);
                expect(
                    historyEvents.flatMap((event) => (event.type === "lifecycle-metadata" ? [event.payload.kind] : [])),
                ).toEqual(expect.arrayContaining(["prompt.requested", "prompt.started", "prompt.completed"]));
                expect(historyEvents.map((event) => BigInt(event.position))).toEqual(
                    historyEvents
                        .map((event) => BigInt(event.position))
                        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
                );
                expect(new Set(historyEvents.map((event) => event.eventId)).size).toBe(historyEvents.length);
                expect(historyEvents.every((event) => /^event-[0-9a-f]{64}$/u.test(event.eventId))).toBe(true);
                break;
            }
            releaseQueued.resolve();
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === queued
                ) {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
        });
    } finally {
        releaseActive.resolve();
        releaseQueued.resolve();
    }
});

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
                    cursor: null,
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
                const recovered = decodeSessionLiveHistoryV2PageLoaded(message).events;
                expect(recovered.queuedPromptRequests).toEqual([
                    expect.objectContaining({ commandId: first }),
                    expect.objectContaining({ commandId: cancelled }),
                    expect.objectContaining({ commandId: last }),
                ]);
                break;
            }
            peer.send(
                encodeSessionCancelCommand({ kind: "session.cancel", sessionId: peer.sessionId, commandId: cancelled }),
            );
            for (;;) {
                const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(cancelled);
                    expect(event.payload.stopReason).toBe("cancelled");
                    break;
                }
            }
            release.resolve();
            const started: string[] = [];
            const completed: string[] = [];
            const replies = new Map<string, string>();
            while (completed.length < 3) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                for (const event of decodeSessionEventEnvelopeV2(message).events) {
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                        started.push(event.payload.commandId);
                    }
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        const current = started.at(-1) ?? active;
                        replies.set(current, `${replies.get(current) ?? ""}${event.payload.content.text}`);
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        expect(event.payload.stopReason).toBe("end_turn");
                        completed.push(event.payload.commandId);
                    }
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
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                const failure = decodeSessionEventEnvelopeV2(message).events.find(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start"),
                );
                if (
                    failure?.type === "lifecycle-metadata" &&
                    (failure.payload.kind === "prompt.failed" || failure.payload.kind === "prompt.failed-before-start")
                ) {
                    expect(failure.payload.commandId).toBe(invalid);
                    expect(failure.payload.code).toBe("prompt_queue_target_unavailable");
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
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                const events = decodeSessionEventEnvelopeV2(message).events;
                const failure = events.find(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start"),
                );
                if (failure !== undefined) {
                    throw new Error(JSON.stringify(failure));
                }
                const completion = events.find(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                );
                if (completion?.type === "lifecycle-metadata" && completion.payload.kind === "prompt.completed") {
                    expect(completion.payload.commandId).toBe(late);
                    expect(completion.payload.stopReason).toBe("end_turn");
                    expect(acknowledged).toBe(true);
                    break;
                }
            }
        });
    } finally {
        release.resolve();
    }
});
