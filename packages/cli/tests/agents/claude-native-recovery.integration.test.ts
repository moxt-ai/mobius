import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRecordedSessionEvent,
    decodeSessionQueuedEvent,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
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
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    kind: "native.session.request",
                    action: "create",
                    requestId,
                    agentId: "claude",
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
        });
    } finally {
        release.resolve();
    }
});

test("Given a completed real claude Session, When it is forked and immediately prompted, Then the first child Turn completes", async () => {
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
                const event = decodeRecordedSessionEvent(await peer.nextEvent());
                if (event.kind === "session.failed" && event.commandId === commandId) {
                    throw new Error(JSON.stringify(event));
                }
                if (event.kind === "agent.message.delta" && event.commandId === commandId) {
                    text += event.text;
                }
                if (event.kind === "session.completed" && event.commandId === commandId) {
                    expect(event.sessionId).toBe(sessionId);
                    expect(event.stopReason).toBe("end_turn");
                    return text;
                }
            }
        };

        const sourceCommandId = randomUUID();
        sendPrompt(peer.sessionId, sourceCommandId);
        expect(await finish(peer.sessionId, sourceCommandId)).toContain("CLAUDE_FORK_REPLY");

        const childSessionId = randomUUID();
        const requestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                action: "fork-recorded",
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: peer.bindingId,
                directoryId: "default",
                kind: "native.session.request",
                requestId,
                sessionId: peer.sessionId,
                targetSessionId: childSessionId,
                throughCommandId: sourceCommandId,
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
                if (result.action !== "fork-recorded") {
                    throw new Error(`Expected fork-recorded, received ${result.action}`);
                }
                expect(result.targetSessionId).toBe(childSessionId);
                break;
            }
        }

        const childCommandId = randomUUID();
        sendPrompt(childSessionId, childCommandId);
        expect(await finish(childSessionId, childCommandId)).toContain("CLAUDE_FORK_REPLY");
    });
});
