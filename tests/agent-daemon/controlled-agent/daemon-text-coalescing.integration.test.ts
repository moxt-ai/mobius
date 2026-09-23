import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentMessageDeltaEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionCompletedEvent,
    decodeSessionEventEnvelope,
    decodeSessionFailedEvent,
    decodeSessionStartedEvent,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port, sendText } from "../../../tests/infra/websocket.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

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
            this.#messages.push(message);
            const resolve = this.#resolvers.shift();
            if (resolve !== undefined) {
                resolve(message);
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

describe("daemon assistant text coalescing", () => {
    it("Given a token-level Agent emits a burst of message chunks, When the turn completes, Then the daemon forwards them as far fewer deltas without losing text", async () => {
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

            let deltaCount = 0;
            let deltaText = "";
            let completed = false;
            let eventSequence = 0;
            while (!completed) {
                const message = await frames.next();
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const envelope = decodeSessionEventEnvelope(message);
                eventSequence += 1;
                sendText(
                    socket,
                    encodeSessionEventAcknowledgement({
                        cursor: `cursor-${eventSequence.toString()}`,
                        duplicate: false,
                        eventId: envelope.eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                        sequence: eventSequence.toString(),
                        sessionId: envelope.sessionId,
                    }),
                );
                const kind = decodeMessageKind(envelope.payload);
                if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    const payload: unknown = JSON.parse(envelope.payload);
                    expect(payload).toMatchObject({ epoch: expect.any(String), sequence: expect.any(Number) });
                    deltaCount += 1;
                    deltaText += typeof payload === "object" && payload !== null ? Reflect.get(payload, "text") : "";
                }
                if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
                    completed = true;
                }
            }

            // Every burst token must survive, in order, with no duplication.
            const expectedBurst = Array.from({ length: 64 }, (_value, index) => `token-${index.toString()} `).join("");
            expect(deltaText).toContain(expectedBurst);
            // A burst of 64 chunks must not become 64 durable events.
            expect(deltaCount).toBeGreaterThan(0);
            expect(deltaCount).toBeLessThan(64);
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

    it("Given a native Agent Turn has emitted partial text, When another viewer reads active state, Then the daemon returns a bounded snapshot and releases it after cancellation", async () => {
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
                prompt: "hold after first delta",
                resources: [],
                sessionId,
                targetCommandId: "",
            };
            let eventSequence = 0;
            const next = async (): Promise<string> => {
                for (;;) {
                    const message = await frames.next();
                    if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                        return message;
                    }
                    const envelope = decodeSessionEventEnvelope(message);
                    eventSequence += 1;
                    sendText(
                        socket,
                        encodeSessionEventAcknowledgement({
                            cursor: `cursor-${eventSequence.toString()}`,
                            duplicate: false,
                            eventId: envelope.eventId,
                            kind: SESSION_EVENT_ACK_KIND,
                            sequence: eventSequence.toString(),
                            sessionId,
                        }),
                    );
                    return envelope.payload;
                }
            };
            sendText(socket, encodeSessionPromptCommand(prompt));
            let delta: string;
            do {
                delta = await next();
            } while (decodeMessageKind(delta) !== AGENT_MESSAGE_DELTA_KIND);
            const firstDelta = decodeAgentMessageDeltaEvent(delta);
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
                    epoch: firstDelta.epoch,
                    prompt: prompt.prompt,
                    sequence: firstDelta.sequence,
                    text: "Partial reply",
                    truncated: false,
                },
            });
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
