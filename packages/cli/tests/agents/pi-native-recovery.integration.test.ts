import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEvent,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/runtime/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
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
            const nativeId = await prepareNewRealSession(peer, "pi");
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

test("Given a real Pi native Session was previewed, When the user imports it, Then the daemon stays online and opens the Session", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_PREVIEW_IMPORT_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sourceSessionId = await prepareNewRealSession(peer, "pi");
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                sessionId: sourceSessionId,
                agentId: "pi",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                images: [],
                resources: [],
                prompt: "Reply with a short greeting, without using tools",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
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
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                break;
            }
        }

        const discoveryId = randomUUID();
        const listRequestId = randomUUID();
        const identity = {
            additionalDirectoryIds: [],
            agentId: "pi",
            bindingId: peer.bindingId,
            directoryId: "default",
        } as const;
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "list",
                cursor: null,
                kind: "native.session.request",
                requestId: listRequestId,
                sessionId: discoveryId,
            }),
        );
        let entry: Extract<
            ReturnType<typeof decodeNativeSessionResult>,
            { readonly action: "list" }
        >["entries"][number];
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== listRequestId || result.action !== "list") {
                continue;
            }
            const source = result.entries.find((candidate) => candidate.mobiusSessionIds.includes(sourceSessionId));
            if (source === undefined) {
                throw new Error("Missing source native Session");
            }
            entry = source;
            break;
        }

        const previewRequestId = randomUUID();
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                ...identity,
                cursor: null,
                eventLimit: 200,
                kind: "session.preview-history.page.load",
                requestId: previewRequestId,
                sessionId: entry.nativeSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.preview-history.page.loaded") {
                continue;
            }
            const preview = decodeSessionPreviewHistoryPageLoaded(message);
            if (preview.requestId === previewRequestId) {
                expect(preview.events.events.events.length).toBeGreaterThan(0);
                break;
            }
        }

        const importedSessionId = randomUUID();
        const importRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "import",
                entryId: entry.entryId,
                kind: "native.session.request",
                requestId: importRequestId,
                sessionId: discoveryId,
                targetSessionId: importedSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== importRequestId || result.action !== "import") {
                continue;
            }
            expect(result.targetSessionId).toBe(importedSessionId);
            expect(result.ready.restored).toBe(true);
            break;
        }
    });
});

test("Given a saved real Pi native Session, When the user forks it, Then its history is visible before the independent Session continues", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_FORK_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sourceSessionId = await prepareNewRealSession(peer, "pi");
        const sourceCommandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId: sourceCommandId,
                sessionId: sourceSessionId,
                agentId: "pi",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                images: [],
                resources: [],
                prompt: "Save this conversation so it can be forked",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === sourceCommandId
            ) {
                break;
            }
        }

        const discoveryId = randomUUID();
        const listRequestId = randomUUID();
        const identity = {
            additionalDirectoryIds: [],
            agentId: "pi",
            bindingId: peer.bindingId,
            directoryId: "default",
        } as const;
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "list",
                cursor: null,
                kind: "native.session.request",
                requestId: listRequestId,
                sessionId: discoveryId,
            }),
        );
        let entry: Extract<
            ReturnType<typeof decodeNativeSessionResult>,
            { readonly action: "list" }
        >["entries"][number];
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== listRequestId || result.action !== "list") {
                continue;
            }
            expect(result.capabilities.unstableForkSession).toBe(true);
            const source = result.entries.find((candidate) => candidate.mobiusSessionIds.includes(sourceSessionId));
            if (source === undefined) {
                throw new Error("Missing source native Session");
            }
            entry = source;
            break;
        }

        const forkedSessionId = randomUUID();
        const forkRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "fork",
                entryId: entry.entryId,
                kind: "native.session.request",
                requestId: forkRequestId,
                sessionId: discoveryId,
                targetSessionId: forkedSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
            }
            if (kind !== "native.session.result") {
                continue;
            }
            const result = decodeNativeSessionResult(message);
            if (result.requestId !== forkRequestId || result.action !== "fork") {
                continue;
            }
            expect(result.targetSessionId).toBe(forkedSessionId);
            expect(result.ready.sessionId).toBe(forkedSessionId);
            expect(result.ready.restored).toBe(true);
            break;
        }

        const historyRequestId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 50,
                kind: "session.live-history.v2.page.load",
                requestId: historyRequestId,
                sessionId: forkedSessionId,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
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
            ).toContain("Save this conversation so it can be forked");
            break;
        }

        const forkedCommandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId: forkedCommandId,
                sessionId: forkedSessionId,
                agentId: "pi",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                images: [],
                resources: [],
                prompt: "Continue in the independent fork",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
        let reply = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === forkedCommandId
            ) {
                expect(reply).toContain("PI_FORK_REPLY");
                break;
            }
        }
    });
});
