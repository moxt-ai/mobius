import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    AGENT_CONTENT_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentActivityEvent,
    decodeAgentActivityNarrationEvent,
    decodeAgentContentEvent,
    decodeAgentMessageDeltaEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionCompletedEvent,
    decodeSessionEventEnvelope,
    decodeSessionFailedEvent,
    decodeSessionLiveHistoryLoaded,
    decodeSessionLiveHistoryPageLoaded,
    decodeSessionQueuedEvent,
    decodeSessionStartedEvent,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryLoad,
    encodeSessionLiveHistoryPageLoad,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_LIVE_HISTORY_LOADED_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOADED_KIND,
    SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_QUEUED_KIND,
    SESSION_STARTED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { runDaemon } from "../../src/run-daemon.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../support/acp/fake-acp-agent/src/cli.ts", import.meta.url));

class ClientFrames {
    #buffered = Buffer.alloc(0);
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];

    constructor(socket: Duplex) {
        socket.on("data", (chunk: Buffer) => {
            this.#buffered = Buffer.concat([this.#buffered, chunk]);
            this.#drain();
        });
    }

    #drain(): void {
        for (;;) {
            const message = this.#readFrame();
            if (message === null) {
                return;
            }
            const resolve = this.#resolvers.shift();
            if (resolve !== undefined) {
                resolve(message);
            } else {
                this.#messages.push(message);
            }
        }
    }

    #readFrame(): string | null {
        if (this.#buffered.byteLength < 2) {
            return null;
        }
        const first = this.#buffered[0] ?? 0;
        const second = this.#buffered[1] ?? 0;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (this.#buffered.byteLength < 4) {
                return null;
            }
            length = this.#buffered.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (this.#buffered.byteLength < 10) {
                return null;
            }
            length = Number(this.#buffered.readBigUInt64BE(2));
            if (!Number.isSafeInteger(length)) {
                throw new Error("WebSocket frame is too large");
            }
            offset = 10;
        }
        const maskLength = masked ? 4 : 0;
        if (this.#buffered.byteLength < offset + maskLength + length) {
            return null;
        }
        const mask = masked ? this.#buffered.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = Buffer.from(this.#buffered.subarray(offset, offset + length));
        if (mask !== null) {
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
            }
        }
        this.#buffered = this.#buffered.subarray(offset + length);
        if ((first & 0x0f) === 0x8) {
            return null;
        }
        return payload.toString("utf8");
    }

    readonly next = (): Promise<string> => {
        const buffered = this.#messages.shift();
        if (buffered !== undefined) {
            return Promise.resolve(buffered);
        }
        return new Promise<string>((resolve) => {
            this.#resolvers.push(resolve);
        });
    };
}

async function startControlledDaemon(): Promise<{
    readonly agent: LocalAgentDefinition;
    readonly close: () => Promise<void>;
    readonly config: ReturnType<typeof createDaemonConfig>;
    readonly frames: ClientFrames;
    readonly socket: Duplex;
}> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-timeline-"));
    const workspace = join(stateDirectory, "workspace");
    const nativeStateDirectory = join(stateDirectory, "native");
    await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);
    const socketReady = Promise.withResolvers<Duplex>();
    const relaySockets = new Set<Duplex>();
    const relay = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
    });
    relay.on("connection", (socket) => {
        relaySockets.add(socket);
        socket.once("close", () => relaySockets.delete(socket));
        socket.on("error", () => undefined);
    });
    relay.on("upgrade", (request, socket) => {
        const key = request.headers["sec-websocket-key"];
        if (typeof key !== "string") {
            socket.destroy();
            return;
        }
        const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Connection: Upgrade\r\n" +
                "Upgrade: websocket\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
        socketReady.resolve(socket);
    });
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
    relayUrl.searchParams.set("token", "d".repeat(43));
    const agent = new LocalAgentDefinition(
        "opencode",
        "OpenCode",
        process.execPath,
        [fakeAgentPath, "--agent-name", "OpenCode"],
        { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
    );
    const config = createDaemonConfig(
        { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal);
    const socket = await socketReady.promise;
    return {
        agent,
        config,
        frames: new ClientFrames(socket),
        socket,
        close: async () => {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const relaySocket of relaySockets) {
                relaySocket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        },
    };
}

describe("daemon assistant text coalescing", () => {
    it("Given Agent text surrounds a tool call, When live history is reopened, Then the timeline keeps the true event order", async () => {
        const fixture = await startControlledDaemon();
        try {
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: fixture.agent.id,
                bindingId: fixture.config.bindingId,
                commandId: "ordered_timeline_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "interleave progress and hold",
                resources: [],
                sessionId: "ordered_timeline_session",
                targetCommandId: "",
            };
            sendText(fixture.socket, encodeSessionPromptCommand(prompt));
            const observedOrder: string[] = [];
            for (;;) {
                const frame = await fixture.frames.next();
                if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const payload = decodeSessionEventEnvelope(frame).payload;
                const kind = decodeMessageKind(payload);
                if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    const delta = decodeAgentMessageDeltaEvent(payload);
                    if (delta.text.includes("Checking the workspace")) {
                        observedOrder.push("first-message");
                    }
                    if (delta.text.includes("OpenCode turn 1: interleave progress and hold")) {
                        observedOrder.push("final-message");
                        break;
                    }
                } else if (kind === AGENT_ACTIVITY_KIND) {
                    const activity = decodeAgentActivityEvent(payload);
                    if (activity.activityType === "tool" && activity.status === "completed") {
                        observedOrder.push("tool");
                    }
                } else if (kind === SESSION_FAILED_KIND) {
                    throw new Error(payload);
                }
            }
            expect(observedOrder).toEqual(["first-message", "tool", "final-message"]);
            sendText(
                fixture.socket,
                encodeNativeSessionRequest({
                    action: "active-turn",
                    additionalDirectoryIds: [],
                    agentId: fixture.agent.id,
                    bindingId: fixture.config.bindingId,
                    directoryId: "default",
                    kind: "native.session.request",
                    requestId: "reopened_active_turn",
                    sessionId: prompt.sessionId,
                    targetSessionId: prompt.sessionId,
                }),
            );
            let result: string;
            do {
                result = await fixture.frames.next();
            } while (decodeMessageKind(result) !== NATIVE_SESSION_RESULT_KIND);
            const reopened = decodeNativeSessionResult(result);
            if (reopened.action !== "active-turn" || reopened.turn === null) {
                throw new Error("Expected the reopened active Turn");
            }
            const latest = reopened.turn;
            const firstMessageIndex = latest.messages.findIndex((message) => message.text === "Checking the workspace");
            const toolIndex = latest.messages.findIndex(
                (message) =>
                    message.role === "assistant" &&
                    message.activities.some((activity) => activity.activityType === "tool"),
            );
            const finalMessageIndex = latest.messages.findIndex((message) =>
                message.text.includes("OpenCode turn 1: interleave progress and hold"),
            );
            expect(firstMessageIndex).toBeGreaterThanOrEqual(0);
            expect(toolIndex).toBeGreaterThan(firstMessageIndex);
            expect(finalMessageIndex).toBeGreaterThan(toolIndex);

            sendText(
                fixture.socket,
                encodeSessionLiveHistoryPageLoad({
                    additionalDirectoryIds: [],
                    agentId: fixture.agent.id,
                    bindingId: fixture.config.bindingId,
                    cursor: null,
                    directoryId: "default",
                    kind: "session.live-history.page.load",
                    limit: 50,
                    requestId: "reopened_ordered_history",
                    sessionId: prompt.sessionId,
                }),
            );
            do {
                result = await fixture.frames.next();
            } while (decodeMessageKind(result) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND);
            const page = decodeSessionLiveHistoryPageLoaded(result).page;
            expect(page).toMatchObject({ status: "available" });
            if (page.status !== "available") {
                throw new Error("Expected live history");
            }
            expect(page.messages).toEqual(
                latest.messages.map((message) =>
                    message.role === "user"
                        ? { role: "user", text: message.text }
                        : {
                              activities: message.activities,
                              content: message.content,
                              role: "assistant",
                              text: message.text,
                          },
                ),
            );

            sendText(
                fixture.socket,
                encodeSessionCancelCommand({
                    commandId: prompt.commandId,
                    kind: SESSION_CANCEL_KIND,
                    sessionId: prompt.sessionId,
                }),
            );
            for (;;) {
                const frame = await fixture.frames.next();
                if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const payload = decodeSessionEventEnvelope(frame).payload;
                if (
                    decodeMessageKind(payload) === SESSION_COMPLETED_KIND &&
                    decodeSessionCompletedEvent(payload).commandId === prompt.commandId
                ) {
                    break;
                }
                if (
                    decodeMessageKind(payload) === SESSION_FAILED_KIND &&
                    decodeSessionFailedEvent(payload).commandId === prompt.commandId
                ) {
                    throw new Error(payload);
                }
            }
        } finally {
            await fixture.close();
        }
    }, 30_000);

    it("Given a token-level Agent emits a burst of message chunks, When the turn completes, Then bounded live deltas preserve every token without cumulative snapshots", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-text-coalescing-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const agent = new LocalAgentDefinition(
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: "burst_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "stream token burst",
                resources: [],
                sessionId: "burst_conversation",
                targetCommandId: "",
            };
            sendText(socket, encodeSessionPromptCommand(prompt));

            let streamedText = "";
            let receivedCumulativeSnapshot = false;
            let completed = false;
            while (!completed) {
                const message = await frames.next();
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const envelope = decodeSessionEventEnvelope(message);
                const kind = decodeMessageKind(envelope.payload);
                if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    const delta = decodeAgentMessageDeltaEvent(envelope.payload);
                    expect(delta).toMatchObject({ epoch: expect.any(String), sequence: expect.any(Number) });
                    streamedText += delta.text;
                }
                if (kind === "session.turn.updated") {
                    receivedCumulativeSnapshot = true;
                }
                if (kind === SESSION_FAILED_KIND) {
                    throw new Error(envelope.payload);
                }
                if (kind === SESSION_COMPLETED_KIND) {
                    expect(decodeSessionCompletedEvent(envelope.payload).stopReason).toBe("end_turn");
                    completed = true;
                }
            }

            // Every burst token must survive, in order, with no duplication.
            const expectedBurst = Array.from({ length: 64 }, (_value, index) => `token-${index.toString()} `).join("");
            expect(streamedText).toBe(`DeepSeek Harness turn 1: ${expectedBurst}`);
            expect(receivedCumulativeSnapshot).toBe(false);
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);

    it("Given a native Agent Turn has emitted more than 100k characters, When another viewer queries native messages, Then the daemon includes the active Turn and releases it after cancellation", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-active-turn-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);
        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const agent = new LocalAgentDefinition(
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);
        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionId = "snapshot_conversation";
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: "snapshot_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "hold after large output",
                resources: [],
                sessionId,
                targetCommandId: "",
            };
            const next = async (): Promise<string> => {
                for (;;) {
                    const message = await frames.next();
                    if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                        return message;
                    }
                    const envelope = decodeSessionEventEnvelope(message);
                    return envelope.payload;
                }
            };
            sendText(socket, encodeSessionPromptCommand(prompt));
            let output = "";
            let firstDelta: ReturnType<typeof decodeAgentMessageDeltaEvent> | null = null;
            let lastSequence = 0;
            while (output.length < 300_000) {
                const message = await next();
                if (decodeMessageKind(message) === AGENT_MESSAGE_DELTA_KIND) {
                    const delta = decodeAgentMessageDeltaEvent(message);
                    firstDelta ??= delta;
                    expect(delta.sequence).toBeGreaterThan(lastSequence);
                    lastSequence = delta.sequence;
                    output += delta.text;
                }
            }
            expect(output).toBe("x".repeat(300_000));
            if (firstDelta === null) {
                throw new Error("Expected a live Agent text delta");
            }
            const request = (requestId: string) =>
                encodeNativeSessionRequest({
                    action: "active-turn",
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "native.session.request",
                    requestId,
                    sessionId,
                    targetSessionId: sessionId,
                });
            sendText(socket, request("active_one"));
            let result: string;
            do {
                result = await next();
            } while (decodeMessageKind(result) !== NATIVE_SESSION_RESULT_KIND);
            const active = decodeNativeSessionResult(result);
            if (active.action !== "active-turn" || active.turn === null) {
                throw new Error("Expected an active Turn snapshot");
            }
            expect(active.turn.sequence).toBe(lastSequence);
            const recoveredOutput = active.turn.messages
                .flatMap((message) => (message.role === "assistant" ? [message.text] : []))
                .join("");
            expect(output.endsWith(recoveredOutput)).toBe(true);
            expect(recoveredOutput.length).toBeLessThan(output.length);
            expect(
                active.turn.messages.reduce(
                    (characters, message) =>
                        characters +
                        message.text.length +
                        (message.role === "assistant"
                            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
                            : 0),
                    0,
                ),
            ).toBeLessThanOrEqual(SESSION_HISTORY_CHARACTER_LIMIT);
            expect(active.turn).toMatchObject({
                commandId: prompt.commandId,
                epoch: firstDelta.epoch,
                hasOlder: true,
                sequence: expect.any(Number),
                truncated: false,
            });
            sendText(
                socket,
                encodeSessionLiveHistoryPageLoad({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    cursor: null,
                    directoryId: "default",
                    kind: "session.live-history.page.load",
                    limit: 50,
                    requestId: "native_messages_with_active_turn",
                    sessionId,
                }),
            );
            do {
                result = await next();
            } while (decodeMessageKind(result) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND);
            const activePage = decodeSessionLiveHistoryPageLoaded(result).page;
            expect(activePage).toMatchObject({ status: "available" });
            if (activePage.status !== "available") {
                throw new Error("Expected active native history");
            }
            expect(activePage.truncated).toBe(false);
            expect(activePage.nextCursor).not.toBeNull();
            const activeText = activePage.messages
                .flatMap((message) => (message.role === "assistant" ? [message.text] : []))
                .join("");
            expect(output.endsWith(activeText)).toBe(true);
            expect(activeText.length).toBeLessThan(output.length);
            expect(
                activePage.messages.reduce(
                    (characters, message) =>
                        characters +
                        message.text.length +
                        (message.role === "assistant"
                            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
                            : 0),
                    0,
                ),
            ).toBeLessThanOrEqual(SESSION_HISTORY_CHARACTER_LIMIT);
            const activePages = [activePage];
            let activeCursor = activePage.nextCursor;
            while (activeCursor !== null) {
                sendText(
                    socket,
                    encodeSessionLiveHistoryPageLoad({
                        additionalDirectoryIds: [],
                        agentId: agent.id,
                        bindingId: config.bindingId,
                        cursor: activeCursor,
                        directoryId: "default",
                        kind: "session.live-history.page.load",
                        limit: 50,
                        requestId: `older_active_history_${activePages.length.toString()}`,
                        sessionId,
                    }),
                );
                do {
                    result = await next();
                } while (decodeMessageKind(result) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND);
                const olderPage = decodeSessionLiveHistoryPageLoaded(result).page;
                if (olderPage.status !== "available") {
                    throw new Error("Expected an older active native history page");
                }
                expect(olderPage.truncated).toBe(false);
                activePages.push(olderPage);
                activeCursor = olderPage.nextCursor;
            }
            const recoveredPages = activePages.toReversed().flatMap((page) => page.messages);
            expect(
                recoveredPages.flatMap((message) => (message.role === "assistant" ? [message.text] : [])).join(""),
            ).toBe(output);
            expect(new Set(activePages.flatMap((page) => page.coveredMessageIds))).toEqual(
                new Set([`${prompt.commandId}:user`, `${prompt.commandId}:agent`]),
            );
            sendText(socket, encodeSessionPromptCommand({ ...prompt, commandId: "second_burst_turn" }));
            let rejected: string;
            for (;;) {
                rejected = await next();
                const kind = decodeMessageKind(rejected);
                if (kind === SESSION_STARTED_KIND) {
                    expect(decodeSessionStartedEvent(rejected).commandId).not.toBe("second_burst_turn");
                }
                if (
                    kind === SESSION_FAILED_KIND &&
                    decodeSessionFailedEvent(rejected).commandId === "second_burst_turn"
                ) {
                    break;
                }
            }
            expect(decodeSessionFailedEvent(rejected)).toMatchObject({
                code: "session_busy",
                commandId: "second_burst_turn",
            });
            sendText(
                socket,
                encodeSessionPromptCommand({
                    ...prompt,
                    bindingId: "another_binding",
                    commandId: "unauthorized_burst_turn",
                }),
            );
            for (;;) {
                rejected = await next();
                if (
                    decodeMessageKind(rejected) === SESSION_FAILED_KIND &&
                    decodeSessionFailedEvent(rejected).commandId === "unauthorized_burst_turn"
                ) {
                    break;
                }
            }
            expect(decodeSessionFailedEvent(rejected).code).not.toBe("session_busy");
            sendText(
                socket,
                encodeSessionCancelCommand({ commandId: prompt.commandId, kind: SESSION_CANCEL_KIND, sessionId }),
            );
            do {
                result = await next();
            } while (
                !(
                    decodeMessageKind(result) === SESSION_COMPLETED_KIND &&
                    decodeSessionCompletedEvent(result).commandId === prompt.commandId
                ) &&
                !(
                    decodeMessageKind(result) === SESSION_FAILED_KIND &&
                    decodeSessionFailedEvent(result).commandId === prompt.commandId
                )
            );
            sendText(socket, request("active_two"));
            do {
                result = await next();
            } while (decodeMessageKind(result) !== NATIVE_SESSION_RESULT_KIND);
            expect(decodeNativeSessionResult(result)).toMatchObject({ action: "active-turn", turn: null });
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);

    it("Given a native Agent Turn is active, When a follow-up is queued and steered, Then the daemon acknowledges it immediately and injects it into the active Turn", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-active-turn-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);
        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const agent = new LocalAgentDefinition(
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);
        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionId = "snapshot_conversation";
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: "snapshot_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "wait for steering",
                resources: [],
                sessionId,
                targetCommandId: "",
            };
            const next = async (): Promise<string> => {
                for (;;) {
                    const message = await frames.next();
                    if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                        return message;
                    }
                    const envelope = decodeSessionEventEnvelope(message);
                    return envelope.payload;
                }
            };
            sendText(socket, encodeSessionPromptCommand(prompt));
            let started: string;
            do {
                started = await next();
            } while (decodeMessageKind(started) !== SESSION_STARTED_KIND);
            const firstStarted = decodeSessionStartedEvent(started);
            const { activeActivity, activeContent, activeTool } = await (async () => {
                let activeActivity: ReturnType<typeof decodeAgentActivityEvent> | null = null;
                let activeContent: ReturnType<typeof decodeAgentContentEvent> | null = null;
                let activeNarration = "";
                let activeTool: ReturnType<typeof decodeAgentActivityEvent> | null = null;
                for (;;) {
                    const event = await next();
                    const kind = decodeMessageKind(event);
                    if (kind === AGENT_ACTIVITY_KIND) {
                        const activity = decodeAgentActivityEvent(event);
                        activeActivity ??= activity;
                        if (activity.locations.length > 0 && activity.status === "completed") {
                            activeTool = activity;
                        }
                    } else if (kind === AGENT_ACTIVITY_NARRATION_KIND) {
                        activeNarration += decodeAgentActivityNarrationEvent(event).text;
                    } else if (kind === AGENT_CONTENT_KIND) {
                        activeContent = decodeAgentContentEvent(event);
                    }
                    if (
                        activeActivity !== null &&
                        activeContent !== null &&
                        activeNarration.length > 0 &&
                        activeTool !== null
                    ) {
                        return { activeActivity, activeContent: activeContent.content, activeTool };
                    }
                }
            })();
            const request = (requestId: string) =>
                encodeNativeSessionRequest({
                    action: "active-turn",
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "native.session.request",
                    requestId,
                    sessionId,
                    targetSessionId: sessionId,
                });
            sendText(socket, request("active_one"));
            let result: string;
            do {
                result = await next();
            } while (decodeMessageKind(result) !== NATIVE_SESSION_RESULT_KIND);
            const active = decodeNativeSessionResult(result);
            expect(active).toMatchObject({
                action: "active-turn",
                turn: {
                    commandId: prompt.commandId,
                    epoch: firstStarted.epoch,
                    sequence: expect.any(Number),
                    truncated: false,
                },
            });
            if (active.action !== "active-turn" || active.turn === null) {
                throw new Error("Expected an active Turn snapshot");
            }
            const recoveredActivities = active.turn.messages.flatMap((message) =>
                message.role === "assistant" ? message.activities : [],
            );
            const recoveredContent = active.turn.messages.flatMap((message) =>
                message.role === "assistant" ? message.content : [],
            );
            expect(recoveredActivities).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        activityId: activeActivity.activityId,
                        locations: activeActivity.locations,
                    }),
                    expect.objectContaining({
                        activityType: "reasoning",
                        output: expect.stringContaining("Inspecting the workspace"),
                    }),
                    expect.objectContaining({
                        activityId: activeTool.activityId,
                        locations: activeTool.locations,
                        status: "completed",
                    }),
                ]),
            );
            expect(recoveredContent).toContainEqual(activeContent);
            sendText(
                socket,
                encodeSessionLiveHistoryLoad({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "session.live-history.load",
                    requestId: "initial_history_with_active_activity",
                    sessionId,
                }),
            );
            do {
                result = await next();
            } while (decodeMessageKind(result) !== SESSION_LIVE_HISTORY_LOADED_KIND);
            const activeHistory = decodeSessionLiveHistoryLoaded(result).history;
            expect(activeHistory).toMatchObject({ status: "available" });
            if (activeHistory.status !== "available") {
                throw new Error("Expected active Session history");
            }
            expect(activeHistory.messages[0]).toMatchObject({ role: "user", text: prompt.prompt });
            const historyActivities = activeHistory.messages.flatMap((message) =>
                message.role === "assistant" ? message.activities : [],
            );
            const historyContent = activeHistory.messages.flatMap((message) =>
                message.role === "assistant" ? message.content : [],
            );
            expect(historyActivities).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        activityId: activeActivity.activityId,
                        locations: activeActivity.locations,
                    }),
                    expect.objectContaining({
                        activityType: "reasoning",
                        output: expect.stringContaining("Inspecting the workspace"),
                    }),
                    expect.objectContaining({
                        activityId: activeTool.activityId,
                        locations: activeTool.locations,
                        status: "completed",
                    }),
                ]),
            );
            expect(historyContent).toContainEqual(activeContent);
            sendText(
                socket,
                encodeSessionLiveHistoryPageLoad({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    cursor: null,
                    directoryId: "default",
                    kind: "session.live-history.page.load",
                    limit: 50,
                    requestId: "paged_history_with_active_activity",
                    sessionId,
                }),
            );
            do {
                result = await next();
            } while (decodeMessageKind(result) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND);
            const activePage = decodeSessionLiveHistoryPageLoaded(result).page;
            expect(activePage).toMatchObject({ status: "available" });
            if (activePage.status !== "available") {
                throw new Error("Expected active Session history page");
            }
            expect(activePage.messages[0]).toMatchObject({ role: "user", text: prompt.prompt });
            expect(
                activePage.messages.flatMap((message) => (message.role === "assistant" ? message.activities : [])),
            ).toEqual(historyActivities);
            expect(
                activePage.messages.flatMap((message) => (message.role === "assistant" ? message.content : [])),
            ).toEqual(historyContent);
            const cancelledQueuedPrompt: SessionPromptCommand = {
                ...prompt,
                commandId: "cancelled_queued_follow_up",
                disposition: SessionPromptDisposition.Queue,
                prompt: "do not run this follow-up",
                targetCommandId: prompt.commandId,
            };
            sendText(socket, encodeSessionPromptCommand(cancelledQueuedPrompt));
            do {
                result = await next();
            } while (
                decodeMessageKind(result) !== SESSION_QUEUED_KIND ||
                decodeSessionQueuedEvent(result).commandId !== cancelledQueuedPrompt.commandId
            );
            sendText(
                socket,
                encodeSessionCancelCommand({
                    commandId: cancelledQueuedPrompt.commandId,
                    kind: SESSION_CANCEL_KIND,
                    sessionId,
                }),
            );
            do {
                result = await next();
            } while (
                !(
                    decodeMessageKind(result) === SESSION_COMPLETED_KIND &&
                    decodeSessionCompletedEvent(result).commandId === cancelledQueuedPrompt.commandId
                )
            );
            expect(decodeSessionCompletedEvent(result).stopReason).toBe("cancelled");
            const queuedPrompt: SessionPromptCommand = {
                ...prompt,
                commandId: "queued_follow_up",
                disposition: SessionPromptDisposition.Queue,
                prompt: "continue after the active turn",
                targetCommandId: prompt.commandId,
            };
            sendText(socket, encodeSessionPromptCommand(queuedPrompt));
            do {
                result = await next();
            } while (
                decodeMessageKind(result) !== SESSION_QUEUED_KIND ||
                decodeSessionQueuedEvent(result).commandId !== queuedPrompt.commandId
            );
            sendText(
                socket,
                encodeSessionPromptDispositionCommand({
                    commandId: queuedPrompt.commandId,
                    disposition: SessionPromptDisposition.Steer,
                    kind: SESSION_PROMPT_DISPOSITION_KIND,
                    sessionId,
                }),
            );
            do {
                result = await next();
            } while (
                !(
                    decodeMessageKind(result) === SESSION_STARTED_KIND &&
                    decodeSessionStartedEvent(result).commandId === queuedPrompt.commandId
                )
            );
            expect(decodeSessionStartedEvent(result)).toMatchObject({
                commandId: queuedPrompt.commandId,
                prompt: queuedPrompt.prompt,
            });
            let steeringCompleted = false;
            let steeredText = "";
            while (!steeredText.includes(`Steered: ${queuedPrompt.prompt}`)) {
                result = await next();
                if (decodeMessageKind(result) === AGENT_MESSAGE_DELTA_KIND) {
                    const delta = decodeAgentMessageDeltaEvent(result);
                    if (delta.commandId === prompt.commandId) {
                        steeredText += delta.text;
                    }
                } else if (decodeMessageKind(result) === SESSION_COMPLETED_KIND) {
                    const completed = decodeSessionCompletedEvent(result);
                    if (completed.commandId === queuedPrompt.commandId) {
                        expect(completed.stopReason).toBe("steered");
                        steeringCompleted = true;
                    }
                } else if (decodeMessageKind(result) === SESSION_FAILED_KIND) {
                    throw new Error(result);
                }
            }
            while (!steeringCompleted) {
                result = await next();
                if (
                    decodeMessageKind(result) === SESSION_COMPLETED_KIND &&
                    decodeSessionCompletedEvent(result).commandId === queuedPrompt.commandId
                ) {
                    expect(decodeSessionCompletedEvent(result).stopReason).toBe("steered");
                    steeringCompleted = true;
                }
            }
            sendText(
                socket,
                encodeSessionCancelCommand({ commandId: prompt.commandId, kind: SESSION_CANCEL_KIND, sessionId }),
            );
            do {
                result = await next();
            } while (
                !(
                    decodeMessageKind(result) === SESSION_COMPLETED_KIND &&
                    decodeSessionCompletedEvent(result).commandId === prompt.commandId
                ) &&
                !(
                    decodeMessageKind(result) === SESSION_FAILED_KIND &&
                    decodeSessionFailedEvent(result).commandId === prompt.commandId
                )
            );
            sendText(socket, request("active_two"));
            do {
                result = await next();
            } while (decodeMessageKind(result) !== NATIVE_SESSION_RESULT_KIND);
            expect(decodeNativeSessionResult(result)).toMatchObject({ action: "active-turn", turn: null });
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
