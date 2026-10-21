import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/runtime/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given a real claude native Session, When the active prompt is cancelled with a follow-up queued, Then the queued prompt restores that Session and completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdResponse = false;
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "NATIVE_RECOVERY_REPLY", {
        beforeFirstText: async () => {
            if (holdResponse) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using agent = await ClaudeFixture.create(provider);
    try {
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const nativeId = await prepareNewRealSession(peer, "claude");
            const sendPrompt = (commandId: string, targetCommandId = ""): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        sessionId: nativeId,
                        agentId: "claude",
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
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
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

test("Given a completed real Claude Session, When it is forked, Then its history is visible before the first child Turn completes", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_FORK_REPLY");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const sendPrompt = (sessionId: string, commandId: string): void =>
            peer.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "claude",
                    bindingId: peer.bindingId,
                    commandId,
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    images: [],
                    kind: "session.prompt",
                    prompt: "Reply with a short greeting, without using tools",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
        const finish = async (sessionId: string, commandId: string): Promise<string> => {
            let text = "";
            for (;;) {
                const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
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
                    expect(event.sessionId).toBe(sessionId);
                    expect(event.payload.stopReason).toBe("end_turn");
                    return text;
                }
            }
        };

        const sourceCommandId = randomUUID();
        sendPrompt(peer.sessionId, sourceCommandId);
        expect(await finish(peer.sessionId, sourceCommandId)).toContain("CLAUDE_FORK_REPLY");

        const childSessionId = randomUUID();
        const identity = {
            additionalDirectoryIds: [],
            agentId: "claude",
            bindingId: peer.bindingId,
            directoryId: "default",
            kind: "native.session.request",
            sessionId: peer.sessionId,
        } as const;
        const listRequestId = randomUUID();
        peer.send(encodeNativeSessionCommand({ ...identity, action: "list", cursor: null, requestId: listRequestId }));
        let entryId: string;
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
            if (result.requestId !== listRequestId) {
                continue;
            }
            if (result.action !== "list") {
                throw new Error("Expected native sessions");
            }
            const entry = result.entries.find((entry) => entry.mobiusSessionIds.includes(peer.sessionId));
            if (entry === undefined) {
                throw new Error("Missing source native session");
            }
            entryId = entry.entryId;
            break;
        }
        const requestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "fork",
                requestId,
                entryId,
                targetSessionId: childSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "native.session.result") {
                const result = decodeNativeSessionResult(message);
                if (result.requestId !== requestId) {
                    continue;
                }
                if (result.action !== "fork") {
                    throw new Error(`Expected fork, received ${result.action}`);
                }
                expect(result.targetSessionId).toBe(childSessionId);
                break;
            }
        }

        const historyRequestId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 50,
                kind: "session.live-history.v2.page.load",
                requestId: historyRequestId,
                sessionId: childSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const loaded = decodeSessionHistoryPageLoaded(message);
            if (loaded.requestId !== historyRequestId) {
                continue;
            }
            expect(
                loaded.events.events.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Reply with a short greeting, without using tools");
            break;
        }

        const childCommandId = randomUUID();
        sendPrompt(childSessionId, childCommandId);
        expect(await finish(childSessionId, childCommandId)).toContain("CLAUDE_FORK_REPLY");
    });
});
