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
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real pi native Session, When the active prompt is cancelled with a follow-up queued, Then the queued prompt restores that Session and completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdResponse = false;
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "NATIVE_RECOVERY_REPLY", {
        beforeFirstText: async () => {
            if (holdResponse) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using agent = await PiFixture.create(provider);
    try {
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    kind: "native.session.request",
                    action: "create",
                    requestId,
                    agentId: "pi",
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
                        agentId: "pi",
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
