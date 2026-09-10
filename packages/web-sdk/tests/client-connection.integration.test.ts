// @vitest-environment happy-dom

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

import {
    decodeMessageKind,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeAgentMessageDeltaEvent,
    encodeCommittedSessionEvent,
    encodeRuntimeStatusEvent,
    encodeSessionCompletedEvent,
    encodeWorkspaceEntriesEvent,
    RUNTIME_STATUS_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_PROMPT_KIND,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectMobiusClient, type MobiusClient } from "../src/client.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

function readPort(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Test relay did not bind to a TCP port");
    }
    return address.port;
}

function writeServerTextFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, "utf8");
    if (payload.byteLength > 65_535) {
        throw new Error("Test relay message is too large");
    }
    const header =
        payload.byteLength < 126
            ? Buffer.from([0x81, payload.byteLength])
            : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
    socket.write(Buffer.concat([header, payload]));
}

function closeServerSocket(socket: Duplex): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1012);
    socket.end(Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]));
}

class ValueFeed<T> {
    readonly #values: T[] = [];
    readonly #waiters: Array<(value: T) => void> = [];

    readonly push = (value: T): void => {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#values.push(value);
            return;
        }
        waiter(value);
    };

    readonly next = (): Promise<T> => {
        const value = this.#values.shift();
        return value === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(value);
    };
}

interface ClientWebSocketFrame {
    readonly opcode: number;
    readonly text: string;
}

class ObservedDelta {
    readonly sequence: string;
    readonly text: string;

    constructor(text: string, sequence: string) {
        this.sequence = sequence;
        this.text = text;
    }
}

function readClientFrame(socket: Duplex): Promise<ClientWebSocketFrame> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const cleanup = (): void => {
            socket.removeListener("close", handleClose);
            socket.removeListener("data", handleData);
            socket.removeListener("error", handleError);
        };
        const fail = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const handleClose = (): void => {
            fail(new Error("Client connection closed before sending a frame"));
        };
        const handleError = (error: Error): void => fail(error);
        const handleData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.byteLength < 6) {
                return;
            }
            const encodedLength = buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                fail(new Error("Test relay received an oversized client frame"));
                return;
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? buffered.readUInt16BE(2) : encodedLength;
            const frameLength = headerLength + 4 + payloadLength;
            if (buffered.byteLength < frameLength) {
                return;
            }
            const mask = buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(buffered.subarray(headerLength + 4, frameLength));
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            cleanup();
            resolve({
                opcode: buffered.readUInt8(0) & 0x0f,
                text: payload.toString("utf8"),
            });
        };
        socket.on("close", handleClose);
        socket.on("data", handleData);
        socket.on("error", handleError);
    });
}

describe("browser relay connection", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given an online browser connection is interrupted, When the relay becomes reachable again, Then the client reconnects without replaying the interrupted command", async () => {
        const relay = createServer();
        const sockets = new Set<Duplex>();
        const connections = new ValueFeed<Duplex>();
        const clientFrames = new ValueFeed<Promise<ClientWebSocketFrame>>();
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            clientFrames.push(readClientFrame(socket));
            connections.push(socket);
            writeServerTextFrame(
                socket,
                encodeRuntimeStatusEvent({
                    kind: RUNTIME_STATUS_KIND,
                    online: true,
                    runtimeId: "runtime-1",
                }),
            );
        });
        await listen(relay);

        vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
        vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
        const statuses = new ValueFeed<boolean>();
        let client: MobiusClient | undefined;

        try {
            const connecting = connectMobiusClient({
                onStatus: statuses.push,
                relayUrl: `ws://127.0.0.1:${readPort(relay).toString()}`,
            });
            await vi.advanceTimersByTimeAsync(0);
            client = await connecting;
            const firstSocket = await connections.next();
            expect(await statuses.next()).toBe(true);

            const interruptedPrompt = client.prompt({
                agentId: "codex",
                bindingId: "workspace",
                commandId: "interrupted-command",
                prompt: "Do not replay this command",
                sessionId: "session-1",
            });
            const firstFrame = await clientFrames.next();
            expect(firstFrame.opcode).toBe(1);
            expect(decodeMessageKind(firstFrame.text)).toBe(SESSION_PROMPT_KIND);
            expect(decodeSessionPromptCommand(firstFrame.text).commandId).toBe("interrupted-command");

            closeServerSocket(firstSocket);
            expect(await statuses.next()).toBe(false);
            await expect(interruptedPrompt).rejects.toMatchObject({
                code: "connection_closed",
            });

            const reconnectedSocket = connections.next();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await reconnectedSocket).not.toBe(firstSocket);
            expect(await statuses.next()).toBe(true);

            const workspaceResult = client.listWorkspace(
                {
                    bindingId: "workspace",
                    directoryId: "default",
                    requestId: "after-reconnect",
                },
                AbortSignal.timeout(5_000),
            );
            const secondFrame = await clientFrames.next();
            expect(decodeMessageKind(secondFrame.text)).toBe(WORKSPACE_LIST_KIND);
            const workspaceRequest = decodeWorkspaceListCommand(secondFrame.text);
            const secondSocket = await reconnectedSocket;
            writeServerTextFrame(
                secondSocket,
                encodeWorkspaceEntriesEvent({
                    bindingId: workspaceRequest.bindingId,
                    directoryId: workspaceRequest.directoryId,
                    directoryLabel: "/workspace",
                    entries: [],
                    kind: WORKSPACE_ENTRIES_KIND,
                    parentDirectoryId: "",
                    requestId: workspaceRequest.requestId,
                }),
            );
            await expect(workspaceResult).resolves.toMatchObject({
                requestId: "after-reconnect",
            });
        } finally {
            client?.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        }
    });

    it("Given the relay commits a streaming delta, When a prompt observer receives it, Then the observer receives the durable event sequence", async () => {
        const relay = createServer();
        const sockets = new Set<Duplex>();
        const connections = new ValueFeed<Duplex>();
        const clientFrames = new ValueFeed<Promise<ClientWebSocketFrame>>();
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            clientFrames.push(readClientFrame(socket));
            connections.push(socket);
            writeServerTextFrame(
                socket,
                encodeRuntimeStatusEvent({
                    kind: RUNTIME_STATUS_KIND,
                    online: true,
                    runtimeId: "runtime-1",
                }),
            );
        });
        await listen(relay);

        const deltas = new ValueFeed<ObservedDelta>();
        let closeClient = (): void => undefined;
        try {
            const client = await connectMobiusClient({
                relayUrl: `ws://127.0.0.1:${readPort(relay).toString()}`,
            });
            closeClient = client.close;
            const socket = await connections.next();
            const result = client.prompt({
                agentId: "codex",
                bindingId: "workspace",
                commandId: "sequenced-command",
                observer: {
                    onDelta: (text, sequence) => {
                        deltas.push(new ObservedDelta(text, sequence));
                    },
                },
                prompt: "Stream a response",
                sessionId: "session-1",
            });
            const frame = await clientFrames.next();
            const prompt = decodeSessionPromptCommand(frame.text);
            const deltaPayload = encodeAgentMessageDeltaEvent({
                commandId: prompt.commandId,
                kind: "agent.message.delta",
                messageId: "agent-message-1",
                sessionId: prompt.sessionId,
                text: "Hello",
            });
            writeServerTextFrame(
                socket,
                encodeCommittedSessionEvent({
                    cursor: "cursor-7",
                    eventId: "delta-7",
                    kind: SESSION_EVENT_COMMITTED_KIND,
                    payload: deltaPayload,
                    recordedAt: "2026-09-08T00:00:00.000Z",
                    sequence: "7",
                    sessionId: prompt.sessionId,
                    source: {
                        attemptId: "attempt-1",
                        kind: "attempt",
                        sourceSeq: "1",
                    },
                }),
            );
            await expect(deltas.next()).resolves.toEqual(new ObservedDelta("Hello", "7"));
            writeServerTextFrame(
                socket,
                encodeCommittedSessionEvent({
                    cursor: "cursor-8",
                    eventId: "completed-8",
                    kind: SESSION_EVENT_COMMITTED_KIND,
                    payload: encodeSessionCompletedEvent({
                        commandId: prompt.commandId,
                        kind: "session.completed",
                        sessionId: prompt.sessionId,
                        stopReason: "end_turn",
                    }),
                    recordedAt: "2026-09-08T00:00:01.000Z",
                    sequence: "8",
                    sessionId: prompt.sessionId,
                    source: {
                        attemptId: "attempt-1",
                        kind: "attempt",
                        sourceSeq: "2",
                    },
                }),
            );
            await expect(result).resolves.toEqual({
                sessionId: "session-1",
                stopReason: "end_turn",
            });
        } finally {
            closeClient();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        }
    });
});
