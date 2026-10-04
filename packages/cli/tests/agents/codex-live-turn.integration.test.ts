import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeFileChunkEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeRuntimeHeartbeatEvent,
    decodeSessionCompletedEvent,
    decodeSessionEventEnvelope,
    decodeSessionLiveHistoryPageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptCommand,
    decodeSessionStartedEvent,
    encodeFileReadCommand,
    encodeNativeSessionCommand,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryPageLoad,
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
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOADED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SESSION_STARTED_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { CodexAcpAgent } from "../../src/acp/codex/agent.ts";
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

test("Given real Codex emits a tool, commentary, and final text, When the completed Session history is reopened, Then its timeline remains chronological", async () => {
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
        for (const turnNumber of [1, 2]) {
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
            let epoch: string | undefined;
            let snapshotVerified = false;
            let queuedCancelled = false;
            let text = "";
            const activities = new Map<string, AgentActivityEvent>();
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
                        encodeSessionLiveHistoryPageLoad({
                            kind: "session.live-history.page.load",
                            requestId: randomUUID(),
                            sessionId,
                            agentId: "codex",
                            bindingId: config.bindingId,
                            directoryId: "default",
                            additionalDirectoryIds: [],
                            cursor: null,
                            limit: 50,
                        }),
                    );
                    continue;
                }
                if (decodeMessageKind(message) === SESSION_LIVE_HISTORY_PAGE_LOADED_KIND) {
                    const { page } = decodeSessionLiveHistoryPageLoaded(message);
                    expect(page.status).toBe("available");
                    if (page.status === "available") {
                        expect(page.messages.filter((item) => item.role === "user")).toHaveLength(turnNumber);
                        expect(
                            page.messages.some((item) => item.role === "assistant" && item.activities.length > 0),
                        ).toBe(true);
                    }
                    releaseProvider.resolve();
                    continue;
                }
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const envelope = decodeSessionEventEnvelope(message);
                const kind = decodeMessageKind(envelope.payload);
                if (kind === SESSION_STARTED_KIND) {
                    expect(started).toBe(false);
                    expect(decodeSessionStartedEvent(envelope.payload)).toMatchObject({
                        commandId,
                        epoch: expect.any(String),
                        prompt: "Use a shell tool successfully, then reply using the configured model",
                        sequence: 0,
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
                } else if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    expect(started).toBe(true);
                    const delta = decodeAgentMessageDeltaEvent(envelope.payload);
                    expect(delta.commandId).toBe(commandId);
                    expect(delta.sequence).toBeGreaterThan(sequence);
                    expect(epoch === undefined || delta.epoch === epoch).toBe(true);
                    epoch = delta.epoch;
                    sequence = delta.sequence;
                    text += delta.text;
                    expect(text).not.toContain("Checking the live progress boundary.");
                } else if (kind === AGENT_ACTIVITY_KIND) {
                    const activity = decodeAgentActivityEvent(envelope.payload);
                    expect(activity.commandId).toBe(commandId);
                    activities.set(activity.activityId, activity);
                } else if (kind === SESSION_COMPLETED_KIND) {
                    const completion = decodeSessionCompletedEvent(envelope.payload);
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
                } else if (kind === SESSION_FAILED_KIND) {
                    throw new Error(`Real Codex Turn failed: ${envelope.payload}`);
                }
            }
            expect(started).toBe(true);
            expect(queuedCancelled).toBe(true);
            expect(snapshotVerified).toBe(true);
            expect(sequence).toBeGreaterThan(0);
            expect(text).toContain("Codex live reply");
            expect(
                [...activities.values()].some(
                    (activity) =>
                        activity.activityType === "progress" &&
                        activity.output === "Checking the live progress boundary.",
                ),
            ).toBe(true);
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
                encodeSessionLiveHistoryPageLoad({
                    kind: "session.live-history.page.load",
                    requestId: randomUUID(),
                    sessionId,
                    agentId: "codex",
                    bindingId: config.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    cursor: null,
                    limit: 50,
                }),
            );
            for (;;) {
                const message = await messages.next();
                if (decodeMessageKind(message) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND) {
                    continue;
                }
                const { page } = decodeSessionLiveHistoryPageLoaded(message);
                expect(page.status).toBe("available");
                if (page.status === "available") {
                    expect(page.messages.filter((item) => item.role === "user")).toHaveLength(turnNumber);
                    const firstUserIndex = page.messages.findIndex((item) => item.role === "user");
                    const nextUserIndex = page.messages.findIndex(
                        (item, index) => index > firstUserIndex && item.role === "user",
                    );
                    const firstTurn = page.messages.slice(
                        firstUserIndex + 1,
                        nextUserIndex < 0 ? page.messages.length : nextUserIndex,
                    );
                    const toolIndex = firstTurn.findIndex(
                        (item) =>
                            item.role === "assistant" &&
                            item.activities.some((activity) => activity.activityType === "tool"),
                    );
                    const commentaryIndex = firstTurn.findIndex(
                        (item) =>
                            item.role === "assistant" &&
                            item.activities.some(
                                (activity) =>
                                    activity.activityType === "progress" &&
                                    activity.output === "Checking the live progress boundary.",
                            ),
                    );
                    const finalIndex = firstTurn.findIndex(
                        (item) => item.role === "assistant" && item.text.includes("Codex live reply"),
                    );
                    expect(toolIndex).toBeGreaterThanOrEqual(0);
                    expect(commentaryIndex).toBeGreaterThan(toolIndex);
                    expect(finalIndex).toBeGreaterThan(commentaryIndex);
                }
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
