import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeFileChunkEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptCommand,
    encodeFileReadCommand,
    encodeNativeSessionCommand,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    FILE_CHUNK_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { CodexAcpAgent } from "../../src/acp/harness/codex/agent.ts";
import { InProcessAcpAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { runDaemon } from "../../src/run-daemon.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

class Messages {
    readonly #closed = Promise.withResolvers<never>();
    readonly #buffered: string[] = [];
    readonly #waiting: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        void this.#closed.promise.catch(() => {});
        socket.once("close", () => this.#closed.reject(new Error("The daemon disconnected during the request")));
        socket.on("message", (value) => {
            const message = value.toString();
            if (decodeMessageKind(message) === RUNTIME_HEARTBEAT_KIND) {
                const heartbeat = decodeRuntimeHeartbeatEvent(message);
                socket.send(
                    encodeRuntimeHeartbeatAckEvent({
                        heartbeatId: heartbeat.heartbeatId,
                        kind: RUNTIME_HEARTBEAT_ACK_KIND,
                    }),
                );
                return;
            }
            const resolve = this.#waiting.shift();
            if (resolve === undefined) {
                this.#buffered.push(message);
            } else {
                resolve(message);
            }
        });
        socket.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
    }

    readonly next = (): Promise<string> => {
        const buffered = this.#buffered.shift();
        return Promise.race([
            this.#closed.promise,
            buffered === undefined
                ? new Promise<string>((resolve) => this.#waiting.push(resolve))
                : Promise.resolve(buffered),
        ]);
    };
}

test("Given real Codex starts a tool, When clients watch and reopen the completed Session, Then live tool updates merge into one chronological history event", async () => {
    let providerEntered = Promise.withResolvers<void>();
    let releaseProvider = Promise.withResolvers<void>();
    const provider = await FakeOpenAiProvider.start("mobius-test-model", "Codex live reply", {
        commentary: "Checking the live progress boundary.",
        beforeFirstText: async () => {
            providerEntered.resolve();
            await releaseProvider.promise;
        },
    });
    const codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-real-codex-live-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/real-codex/daemon`);
    relayUrl.searchParams.set("token", "r".repeat(43));
    const agent = new InProcessAcpAgentDefinition(
        "codex",
        "Codex",
        codex.executable,
        (options) => new CodexAcpAgent(options),
        codex.environment,
    );
    const config = createDaemonConfig(
        { channelId: "real-codex", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal);

    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        const sessionId = "new_codex_live_turn";
        for (const _turnNumber of [1, 2]) {
            providerEntered = Promise.withResolvers<void>();
            releaseProvider = Promise.withResolvers<void>();
            const commandId = randomUUID();
            const queuedCommandId = randomUUID();
            const originalPrompt = encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "Use a shell tool successfully, then reply using the configured model",
                resources: [],
                sessionId,
                targetCommandId: "",
            });
            socket.send(originalPrompt);
            let started = false;
            let completed = false;
            let sequence = 0;
            let thought = "";
            let _recoveryPosition: {
                readonly commandId: string;
                readonly epoch: string;
                readonly sequence: number;
            } | null = null;
            let snapshotVerified = false;
            let queuedCancelled = false;
            let text = "";

            while (!completed) {
                const message = await messages.next();
                if (decodeMessageKind(message) === "session.queued") {
                    socket.send(
                        encodeNativeSessionCommand({
                            action: "active-turn",
                            additionalDirectoryIds: [],
                            agentId: "codex",
                            bindingId: config.bindingId,
                            directoryId: `path-${Buffer.from(config.defaultWorkspace).toString("base64url")}`,
                            kind: "native.session.request",
                            requestId: "queued_snapshot",
                            sessionId,
                            targetSessionId: sessionId,
                        }),
                    );
                    continue;
                }
                if (decodeMessageKind(message) === NATIVE_SESSION_RESULT_KIND) {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === "queued_snapshot") {
                        expect(result).toMatchObject({
                            queued: [
                                { commandId: queuedCommandId, prompt: "This queued prompt should not run", images: [] },
                            ],
                        });
                        socket.send(
                            encodeSessionCancelCommand({
                                commandId: queuedCommandId,
                                kind: SESSION_CANCEL_KIND,
                                sessionId,
                            }),
                        );
                        continue;
                    }
                    expect(result).toMatchObject({ queued: [] });
                    expect(result.action).toBe("active-turn");
                    if (result.action === "active-turn") {
                        if (result.turn !== null) {
                            _recoveryPosition = {
                                commandId: result.turn.commandId,
                                epoch: result.turn.epoch,
                                sequence: result.turn.sequence,
                            };
                        }
                        expect(result.turn).toMatchObject({
                            commandId,
                            epoch: expect.any(String),
                            interaction: null,
                            sequence: expect.any(Number),
                            state: "running",
                        });
                        expect(result.turn?.messages).toEqual(
                            expect.arrayContaining([
                                expect.objectContaining({
                                    id: commandId,
                                    role: "user",
                                    text: "Use a shell tool successfully, then reply using the configured model",
                                }),
                            ]),
                        );
                    }
                    snapshotVerified = true;
                    socket.send(
                        encodeSessionLiveHistoryV2PageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId: randomUUID(),
                            sessionId,
                            cursor: null,
                            eventLimit: 200,
                        }),
                    );
                    continue;
                }
                if (decodeMessageKind(message) === SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND) {
                    const recovered = decodeSessionLiveHistoryV2PageLoaded(message).events;
                    expect(
                        recovered.events.events.some(
                            (event) => event.type === "acp" && event.payload.sessionUpdate === "tool_call",
                        ),
                    ).toBe(true);
                    releaseProvider.resolve();
                    continue;
                }
                if (decodeMessageKind(message) !== SESSION_EVENT_V2_KIND) {
                    continue;
                }
                for (const event of decodeSessionEventEnvelopeV2(message).events) {
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                        expect(started).toBe(false);
                        expect(event.payload).toMatchObject({
                            commandId,
                            epoch: expect.any(String),
                        });
                        started = true;
                        await providerEntered.promise;
                        socket.send(
                            encodeSessionPromptCommand({
                                additionalDirectoryIds: [],
                                agentId: "codex",
                                bindingId: config.bindingId,
                                commandId: queuedCommandId,
                                directoryId: "default",
                                disposition: SessionPromptDisposition.Queue,
                                images: [],
                                kind: "session.prompt",
                                prompt: "This queued prompt should not run",
                                resources: [],
                                sessionId,
                                targetCommandId: commandId,
                            }),
                        );
                    } else if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        expect(started).toBe(true);
                        expect(Number(event.position)).toBeGreaterThan(sequence);
                        sequence = Number(event.position);
                        text += event.payload.content.text;
                        expect(text).not.toContain("Checking the live progress boundary.");
                    } else if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_thought_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        thought += event.payload.content.text;
                    } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        const completion = event.payload;
                        if (completion.commandId === queuedCommandId) {
                            expect(completion.stopReason).toBe("cancelled");
                            queuedCancelled = true;
                            socket.send(
                                encodeNativeSessionCommand({
                                    action: "active-turn",
                                    additionalDirectoryIds: [],
                                    agentId: "codex",
                                    bindingId: config.bindingId,
                                    directoryId: "default",
                                    kind: "native.session.request",
                                    requestId: randomUUID(),
                                    sessionId,
                                    targetSessionId: sessionId,
                                }),
                            );
                        } else {
                            expect(completion.commandId).toBe(commandId);
                            expect(queuedCancelled).toBe(true);
                            completed = true;
                        }
                    } else if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(`Real Codex Turn failed: ${JSON.stringify(event)}`);
                    }
                }
            }
            expect(started).toBe(true);
            expect(queuedCancelled).toBe(true);
            expect(snapshotVerified).toBe(true);
            expect(sequence).toBeGreaterThan(0);
            expect(text).toContain("Codex live reply");
            expect(thought).toBe("Checking the live progress boundary.");
            const originalCommand = decodeSessionPromptCommand(originalPrompt);
            socket.send(JSON.stringify(Object.fromEntries(Object.entries(originalCommand).reverse())));
            socket.send(
                encodeSessionPromptCommand({ ...originalCommand, prompt: "Conflicting reuse must not execute" }),
            );
            for (;;) {
                const message = await messages.next();
                if (decodeMessageKind(message) !== SESSION_OPERATION_FAILED_KIND) {
                    continue;
                }
                expect(decodeSessionOperationFailedEvent(message)).toMatchObject({
                    requestId: commandId,
                    sessionId,
                    code: "command_identity_conflict",
                });
                break;
            }
            socket.send(
                encodeSessionLiveHistoryV2PageLoad({
                    kind: "session.live-history.v2.page.load",
                    requestId: randomUUID(),
                    sessionId,
                    cursor: null,
                    eventLimit: 200,
                }),
            );
            for (;;) {
                const message = await messages.next();
                if (decodeMessageKind(message) !== SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND) {
                    continue;
                }
                const page = decodeSessionLiveHistoryV2PageLoaded(message).events.events;
                const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
                const toolUpdates = updates.filter(
                    (update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
                );
                const toolIndex = updates.findIndex(
                    (update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
                );
                const commentaryIndex = updates.findIndex(
                    (update) =>
                        (update.sessionUpdate === "agent_message_chunk" ||
                            update.sessionUpdate === "agent_thought_chunk") &&
                        update.content.type === "text" &&
                        updates.indexOf(update) > toolIndex,
                );
                const finalIndex = updates.findIndex(
                    (update) =>
                        update.sessionUpdate === "agent_message_chunk" &&
                        update.content.type === "text" &&
                        update.content.text.includes("Codex live reply"),
                );
                const commentary = updates
                    .slice(commentaryIndex, finalIndex)
                    .flatMap((update) =>
                        (update.sessionUpdate === "agent_message_chunk" ||
                            update.sessionUpdate === "agent_thought_chunk") &&
                        update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    )
                    .join("");
                expect(toolUpdates).toHaveLength(1);
                expect(toolUpdates[0]?.sessionUpdate).toBe("tool_call");
                expect(commentary).toBe("Checking the live progress boundary.");
                expect(toolIndex).toBeGreaterThanOrEqual(0);
                expect(commentaryIndex).toBeGreaterThan(toolIndex);
                expect(finalIndex).toBeGreaterThan(commentaryIndex);
                break;
            }
        }
        const image = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        );
        await writeFile(join(workspace, "badge.png"), image);
        socket.send(
            encodeFileReadCommand({
                kind: "file.read",
                requestId: randomUUID(),
                sessionId,
                path: "badge.png",
                maxBytes: 1024,
            }),
        );
        const chunks: Buffer[] = [];
        for (;;) {
            const message = await messages.next();
            const kind = decodeMessageKind(message);
            expect(kind).not.toBe(FILE_FAILED_KIND);
            if (kind === FILE_CHUNK_KIND) {
                chunks.push(Buffer.from(decodeFileChunkEvent(message).data, "base64"));
            }
            if (kind === FILE_END_KIND) {
                break;
            }
        }
        expect(Buffer.concat(chunks)).toEqual(image);
    } finally {
        releaseProvider.resolve();
        cancellation.abort();
        await daemon;
        audit.close();
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { force: true, recursive: true });
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
    }
}, 120_000);
