// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import {
    decodeAgentInstallCancelCommand,
    decodeAgentInstallRequestCommand,
    encodeRuntimeStatusEvent,
    RUNTIME_STATUS_KIND,
} from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen, port as readPort, sendText as writeServerTextFrame } from "../../test-support/src/websocket.ts";
import { connectMobiusClient, type MobiusClient } from "../src/client.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

    it("Given an online browser connection with an expiring credential, When it reconnects after expiry, Then it resolves a fresh relay URL without replaying the interrupted command", async () => {
        const relay = createServer();
        const sockets = new Set<Duplex>();
        const connections = new ValueFeed<Duplex>();
        const clientFrames = new ValueFeed<Promise<ClientWebSocketFrame>>();
        const upgradeUrls = new ValueFeed<string>();
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            upgradeUrls.push(request.url ?? "");
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
        const credentialExpiresAt = Date.now() + 60 * 60 * 1_000;
        const statuses: boolean[] = [];
        const nextStatus = new ValueFeed<boolean>();
        const reconnecting = new ValueFeed<string>();
        let client: MobiusClient | undefined;

        try {
            const connecting = connectMobiusClient({
                onReconnecting: () => reconnecting.push("reconnecting"),
                onStatus: (online) => {
                    statuses.push(online);
                    nextStatus.push(online);
                },
                relayUrl: async (signal) => {
                    signal.throwIfAborted();
                    const token = Date.now() >= credentialExpiresAt ? "refreshed-credential" : "initial-credential";
                    return `ws://127.0.0.1:${readPort(relay).toString()}/?token=${token}`;
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            client = await connecting;
            const firstSocket = await connections.next();
            expect(await upgradeUrls.next()).toBe("/?token=initial-credential");
            expect(await nextStatus.next()).toBe(true);

            const interruptedInstallation = client.installAgent({
                agentId: "codex",
                requestId: "interrupted-installation",
            });
            const interruptedResult = interruptedInstallation.then(
                () => new Error("Interrupted installation unexpectedly completed"),
                (error: unknown) => error,
            );
            const firstFrame = await clientFrames.next();
            expect(decodeAgentInstallRequestCommand(firstFrame.text).requestId).toBe("interrupted-installation");

            vi.setSystemTime(new Date(credentialExpiresAt + 1));
            closeServerSocket(firstSocket);
            expect(await reconnecting.next()).toBe("reconnecting");
            expect(statuses).toEqual([true]);
            expect(await interruptedResult).toMatchObject({
                code: "connection_closed",
            });

            const reconnectedSocket = connections.next();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await reconnectedSocket).not.toBe(firstSocket);
            expect(await upgradeUrls.next()).toBe("/?token=refreshed-credential");
            expect(await nextStatus.next()).toBe(true);
            expect(statuses).toEqual([true, true]);

            client.cancelAgentInstallation({ requestId: "after-reconnect" });
            const secondFrame = await clientFrames.next();
            expect(decodeAgentInstallCancelCommand(secondFrame.text).requestId).toBe("after-reconnect");
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
});
