import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { listen, port as readPort, sendText as writeServerTextFrame } from "@moxt-ai/mobius-test/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    decodeMessageKind,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventEnvelopeV2,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    MOBIUS_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_PROMPT_KIND,
    type SessionEventV2,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "../../../protocol/src/index.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { createDaemonConfig, LocalAgentDefinition } from "../../src/config.ts";
import { RuntimeRelayRevokedError } from "../../src/relay-connection/runtime-revocation.ts";
import { SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS } from "../../src/relay-connection/session-event-publisher.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../../src/relay-connection/timer.ts";
import { runDaemon } from "../../src/run-daemon.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));

function restoreEnvironmentVariable(name: string, previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = previous;
}

class ClientWebSocketFrame {
    readonly opcode: number;
    readonly text: string;

    constructor(opcode: number, text: string) {
        this.opcode = opcode;
        this.text = text;
    }
}

class ControllableDaemonTask implements DaemonScheduledTask {
    readonly #callback: () => void;
    #cancelled = false;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (this.#cancelled) {
            return;
        }
        this.#cancelled = true;
        this.#callback();
    };
}

class ControllableDaemonTimer implements DaemonTimer {
    readonly #scheduled = new Map<number, ControllableDaemonTask[]>();
    readonly #waiters = new Map<number, Array<(task: ControllableDaemonTask) => void>>();

    readonly schedule = (callback: () => void, milliseconds: number): DaemonScheduledTask => {
        const task = new ControllableDaemonTask(callback);
        const waiter = this.#waiters.get(milliseconds)?.shift();
        if (waiter !== undefined) {
            waiter(task);
            return task;
        }
        const scheduled = this.#scheduled.get(milliseconds) ?? [];
        scheduled.push(task);
        this.#scheduled.set(milliseconds, scheduled);
        return task;
    };

    readonly waitForTask = (milliseconds: number): Promise<ControllableDaemonTask> => {
        const scheduled = this.#scheduled.get(milliseconds);
        const task = scheduled?.shift();
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve) => {
            const waiters = this.#waiters.get(milliseconds) ?? [];
            waiters.push(resolve);
            this.#waiters.set(milliseconds, waiters);
        });
    };
}

function readClientFrame(socket: Duplex): Promise<ClientWebSocketFrame> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const fail = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const cleanup = (): void => {
            socket.removeListener("close", handleClose);
            socket.removeListener("data", handleData);
            socket.removeListener("error", fail);
        };
        const handleClose = (): void => {
            fail(new Error("Daemon connection closed before sending a frame"));
        };
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
            const opcode = buffered.readUInt8(0) & 0x0f;
            cleanup();
            resolve(new ClientWebSocketFrame(opcode, payload.toString("utf8")));
        };
        socket.on("close", handleClose);
        socket.on("data", handleData);
        socket.on("error", fail);
    });
}

function observeClientFrames(socket: Duplex, observe: (frame: ClientWebSocketFrame) => void): () => void {
    let buffered = Buffer.alloc(0);
    const handleData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.byteLength >= 6) {
            const encodedLength = buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                throw new Error("Test relay received an oversized client frame");
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
            observe(new ClientWebSocketFrame(buffered.readUInt8(0) & 0x0f, payload.toString("utf8")));
            buffered = buffered.subarray(frameLength);
        }
    };
    socket.on("data", handleData);
    return () => socket.removeListener("data", handleData);
}

class ClientFrameQueue {
    readonly #frames: ClientWebSocketFrame[] = [];
    readonly #waiters: Array<(frame: ClientWebSocketFrame) => void> = [];
    readonly close: () => void;

    constructor(socket: Duplex) {
        this.close = observeClientFrames(socket, (frame) => {
            const resolve = this.#waiters.shift();
            if (resolve === undefined) {
                this.#frames.push(frame);
            } else {
                resolve(frame);
            }
        });
    }

    readonly next = (): Promise<ClientWebSocketFrame> => {
        const frame = this.#frames.shift();
        return frame === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(frame);
    };
}

function writeServerCloseFrame(socket: Duplex, code: number, reason: string): void {
    const reasonPayload = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(reasonPayload.byteLength + 2);
    payload.writeUInt16BE(code, 0);
    reasonPayload.copy(payload, 2);
    socket.write(Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]));
}

function respondToClientClose(socket: Duplex): void {
    socket.on("data", (chunk: Buffer) => {
        if (chunk.byteLength > 0 && (chunk.readUInt8(0) & 0x0f) === 8) {
            socket.end(Buffer.from([0x88, 0]));
        }
    });
}

describe("daemon relay connection liveness", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given a liveness-capable relay stops acknowledging heartbeats, When the acknowledgement deadline expires, Then the daemon reconnects", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-heartbeat-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url === `${MOBIUS_API_PREFIX}/channels/heartbeat-channel/catalog`) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
        const daemonSockets: Duplex[] = [];
        let livenessRequested = false;
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
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
            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            livenessRequested = requestUrl.searchParams.get("liveness") === "1";
            daemonSockets.push(socket);
            clientFrames.push(readClientFrame(socket));
            respondToClientClose(socket);
            writeServerTextFrame(
                socket,
                JSON.stringify({
                    kind: RUNTIME_LIVENESS_READY_KIND,
                }),
            );
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const audit = new AuditStore();
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            channelId: "heartbeat-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/heartbeat-channel/daemon`,
            ),
        });

        vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
        vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the daemon connection");
            }
            const heartbeatFrame = await firstFrame;
            expect(livenessRequested).toBe(true);
            expect(heartbeatFrame.opcode).toBe(1);
            const firstHeartbeat = decodeRuntimeHeartbeatEvent(heartbeatFrame.text);
            expect(firstHeartbeat.kind).toBe(RUNTIME_HEARTBEAT_KIND);
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const controlResponse = readClientFrame(firstSocket);
            writeServerTextFrame(
                firstSocket,
                encodeRuntimeHeartbeatAckEvent({
                    heartbeatId: firstHeartbeat.heartbeatId,
                    kind: RUNTIME_HEARTBEAT_ACK_KIND,
                }),
            );
            writeServerTextFrame(
                firstSocket,
                encodeWorkspaceListCommand({
                    bindingId: "workspace",
                    directoryId: "default",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "acknowledgement-barrier",
                }),
            );
            expect(decodeMessageKind((await controlResponse).text)).toBe(WORKSPACE_ENTRIES_KIND);

            const unacknowledgedHeartbeat = readClientFrame(firstSocket);
            await vi.advanceTimersByTimeAsync(20_000);
            const secondHeartbeat = decodeRuntimeHeartbeatEvent((await unacknowledgedHeartbeat).text);
            expect(secondHeartbeat.heartbeatId).not.toBe(firstHeartbeat.heartbeatId);

            const refreshedConnection = waitForUpgrade();
            await vi.advanceTimersByTimeAsync(10_000);
            await vi.advanceTimersByTimeAsync(500);
            await refreshedConnection;
            const refreshedFrame = clientFrames[1];
            if (refreshedFrame === undefined) {
                throw new Error("Test relay did not observe the refreshed connection");
            }
            expect((await refreshedFrame).opcode).toBe(1);
        } finally {
            cancellation.abort();
            await vi.runAllTimersAsync();
            await daemon;
            audit.close();
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an active Runtime is revoked by the Relay, When the daemon receives the terminal close, Then it exits instead of reconnecting", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-runtime-revoked-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/runtime-revoked-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        let resolveUpgrade = (_socket: Duplex): void => undefined;
        const upgraded = new Promise<Duplex>((resolve) => {
            resolveUpgrade = resolve;
        });
        let upgradeCount = 0;
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
            upgradeCount += 1;
            respondToClientClose(socket);
            resolveUpgrade(socket);
        });
        await listen(relay);

        const audit = new AuditStore();
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            channelId: "runtime-revoked-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/runtime-revoked-channel/daemon`,
            ),
        });
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const socket = await upgraded;
            writeServerCloseFrame(socket, 1008, "Runtime revoked");

            await expect(daemon).rejects.toBeInstanceOf(RuntimeRelayRevokedError);
            await expect(daemon).rejects.toMatchObject({
                code: "runtime_relay_revoked",
                closeCode: 1008,
                closeReason: "Runtime revoked",
            });
            expect(upgradeCount).toBe(1);
        } finally {
            cancellation.abort();
            await daemon.catch(() => undefined);
            audit.close();
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a healthy idle daemon connection, When the Relay sends a future event and twenty minutes pass, Then the same connection remains available", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-liveness-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let catalogRequestCount = 0;
        let observeCatalogFailure = (): void => undefined;
        const catalogFailure = new Promise<void>((resolve) => {
            observeCatalogFailure = resolve;
        });
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url === `${MOBIUS_API_PREFIX}/channels/liveness-channel/catalog`) {
                catalogRequestCount += 1;
                request.resume();
                response.writeHead(catalogRequestCount === 1 ? 503 : 204);
                response.end();
                if (catalogRequestCount === 1) {
                    observeCatalogFailure();
                }
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const daemonSockets: Duplex[] = [];
        const upgradeWaiters: Array<() => void> = [];
        const requestedUrls: string[] = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
        let connectionCount = 0;
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            daemonSockets.push(socket);
            requestedUrls.push(request.url ?? "");
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
            respondToClientClose(socket);
            writeServerTextFrame(
                socket,
                encodeWorkspaceListCommand({
                    bindingId: "workspace",
                    directoryId: "default",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: `connection-${clientFrames.length.toString()}`,
                }),
            );
            connectionCount += 1;
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const audit = new AuditStore();
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            channelId: "liveness-channel",
            relayUrl: new URL(`ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon`),
        });

        vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
        vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            await catalogFailure;
            await firstConnection;
            const firstResponse = clientFrames[0];
            if (firstResponse === undefined) {
                throw new Error("Test relay did not observe the daemon response");
            }
            expect(decodeMessageKind((await firstResponse).text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(connectionCount).toBe(1);

            await vi.advanceTimersByTimeAsync(20 * 60 * 1_000);
            await vi.advanceTimersByTimeAsync(500);
            const socket = daemonSockets[0];
            if (socket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const response = readClientFrame(socket);
            writeServerTextFrame(socket, JSON.stringify({ kind: "session.future.changed", sessionId: "session-1" }));
            writeServerTextFrame(
                socket,
                encodeWorkspaceListCommand({
                    bindingId: "workspace",
                    directoryId: "default",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "after-twenty-minutes",
                }),
            );
            expect(decodeMessageKind((await response).text)).toBe(WORKSPACE_ENTRIES_KIND);

            expect({ catalogRequestCount, connectionCount, requestedUrls }).toEqual({
                catalogRequestCount: 2,
                connectionCount: 1,
                requestedUrls: [`${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon?liveness=1`],
            });
        } finally {
            cancellation.abort();
            await vi.runAllTimersAsync();
            await daemon;
            audit.close();
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a live daemon sends without acknowledgements, When it reconnects, Then it resumes live delivery without replaying prior events", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-reconciliation-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let reconciliationRequestCount = 0;
        const relay = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                request.method === "PUT" &&
                url.pathname === `${MOBIUS_API_PREFIX}/channels/reconciliation-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            if (request.method === "POST" && url.pathname.endsWith("/reconciliation")) {
                reconciliationRequestCount += 1;
                request.resume();
                response.writeHead(404, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: {
                            code: "not_found",
                            message: "The test Relay does not retain active Turns",
                        },
                    }),
                );
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        const daemonSockets: Duplex[] = [];
        const clientFrames: ClientFrameQueue[] = [];
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
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
            daemonSockets.push(socket);
            respondToClientClose(socket);
            clientFrames.push(new ClientFrameQueue(socket));
            writeServerTextFrame(
                socket,
                encodeRuntimeLivenessReadyEvent({
                    kind: RUNTIME_LIVENESS_READY_KIND,
                }),
            );
            if (daemonSockets.length === 2) {
                writeServerTextFrame(
                    socket,
                    encodeWorkspaceListCommand({
                        bindingId: "workspace",
                        directoryId: "default",
                        kind: WORKSPACE_LIST_KIND,
                        requestId: "after-reconnect",
                    }),
                );
            }
            if (daemonSockets.length === 1 || daemonSockets.length === 3) {
                writeServerTextFrame(
                    socket,
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: "workspace",
                        commandId: "reconciliation-command",
                        directoryId: "default",
                        disposition: "reject",
                        images: [],
                        kind: SESSION_PROMPT_KIND,
                        prompt: "broadcast without viewers",
                        resources: [],
                        sessionId: daemonSockets.length === 1 ? "reconciliation-session" : "fresh-session",
                        targetCommandId: "",
                    }),
                );
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const audit = new AuditStore();
        let cancellation = new AbortController();
        const timer = new ControllableDaemonTimer();
        const previousFakeAcpStateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = join(stateDirectory, "native");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        const config = createDaemonConfig(
            {
                defaultWorkspace,
                channelId: "reconciliation-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/reconciliation-channel/daemon?token=reconciliation-secret`,
                ),
            },
            [new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath])],
        );

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        let daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the active Agent turn");
            }
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the first connection");
            }
            const initialEvents: SessionEventV2[] = [];
            while (
                !initialEvents.some(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                )
            ) {
                (await timer.waitForTask(SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS)).run();
                let frame = await firstFrame.next();
                if (decodeMessageKind(frame.text) === RUNTIME_HEARTBEAT_KIND) {
                    const heartbeat = decodeRuntimeHeartbeatEvent(frame.text);
                    writeServerTextFrame(
                        firstSocket,
                        encodeRuntimeHeartbeatAckEvent({
                            heartbeatId: heartbeat.heartbeatId,
                            kind: RUNTIME_HEARTBEAT_ACK_KIND,
                        }),
                    );
                    frame = await firstFrame.next();
                }
                while (decodeMessageKind(frame.text) !== SESSION_EVENT_V2_KIND) {
                    frame = await firstFrame.next();
                }
                initialEvents.push(...decodeSessionEventEnvelopeV2(frame.text).events);
            }
            expect(initialEvents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.requested" }),
                    }),
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.started" }),
                    }),
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.completed" }),
                    }),
                ]),
            );
            // No delivery acknowledgements exist. Reconnection starts receiving live events.
            // More than the former 16-event window must stream without any delivery ACK.
            for (let turn = 0; turn < 6; turn += 1) {
                writeServerTextFrame(
                    firstSocket,
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: "workspace",
                        commandId: `live-command-${turn}`,
                        directoryId: "default",
                        disposition: "reject",
                        images: [],
                        kind: SESSION_PROMPT_KIND,
                        prompt: "keep broadcasting",
                        resources: [],
                        sessionId: "reconciliation-session",
                        targetCommandId: "",
                    }),
                );
                (await timer.waitForTask(SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS)).run();
                let terminal = false;
                let answer = "";
                while (!terminal) {
                    const frame = await firstFrame.next();
                    if (decodeMessageKind(frame.text) !== SESSION_EVENT_V2_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelopeV2(frame.text).events) {
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            answer += event.payload.content.text;
                        }
                        terminal ||= event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed";
                    }
                    if (!terminal) {
                        (await timer.waitForTask(SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS)).run();
                    }
                }
                expect(answer).toContain("keep broadcasting");
            }
            const secondConnection = waitForUpgrade();
            const firstRetry = timer.waitForTask(500);
            firstSocket.destroy();
            (await firstRetry).run();
            await secondConnection;
            const resumedFrame = clientFrames[1];
            if (resumedFrame === undefined) {
                throw new Error("Test relay did not observe resumed live events");
            }
            let replayedFrame = await resumedFrame.next();
            if (decodeMessageKind(replayedFrame.text) === RUNTIME_HEARTBEAT_KIND) {
                const heartbeat = decodeRuntimeHeartbeatEvent(replayedFrame.text);
                const secondSocket = daemonSockets[1];
                if (secondSocket === undefined) {
                    throw new Error("Test relay did not retain the replacement connection");
                }
                writeServerTextFrame(
                    secondSocket,
                    encodeRuntimeHeartbeatAckEvent({
                        heartbeatId: heartbeat.heartbeatId,
                        kind: RUNTIME_HEARTBEAT_ACK_KIND,
                    }),
                );
                replayedFrame = await resumedFrame.next();
            }
            expect(decodeMessageKind(replayedFrame.text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(reconciliationRequestCount).toBe(0);
            expect(daemonSockets).toHaveLength(2);

            // A fresh daemon also starts with live events, never an old delivery queue.
            cancellation.abort();
            await daemon;
            cancellation = new AbortController();
            const restarted = waitForUpgrade();
            daemon = runDaemon(config, audit, cancellation.signal, timer);
            await restarted;
            (await timer.waitForTask(SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS)).run();
            const freshFrames = clientFrames[2];
            if (freshFrames === undefined) {
                throw new Error("Test relay did not observe the restarted daemon");
            }
            let freshFrame = await freshFrames.next();
            if (decodeMessageKind(freshFrame.text) === RUNTIME_HEARTBEAT_KIND) {
                freshFrame = await freshFrames.next();
            }
            while (decodeMessageKind(freshFrame.text) !== SESSION_EVENT_V2_KIND) {
                freshFrame = await freshFrames.next();
            }
            const freshReady = decodeSessionEventEnvelopeV2(freshFrame.text);
            expect(freshReady.events.every((event) => event.sessionId === "fresh-session")).toBe(true);
            expect(freshReady.events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.requested" }),
                    }),
                ]),
            );
            expect(freshReady).not.toHaveProperty("delivery");
            expect(await readdir(stateDirectory)).not.toContain("events");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
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
            restoreEnvironmentVariable("MOBIUS_FAKE_ACP_STATE_DIRECTORY", previousFakeAcpStateDirectory);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
