import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { listen, port as readPort, sendText as writeServerTextFrame } from "../../../tests/infra/websocket.ts";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeMessageKind,
    decodeRuntimeDeliveryReceived,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventEnvelope,
    encodeRuntimeDelivery,
    encodeRuntimeDeliveryCommitted,
    encodeRuntimeHeartbeatAckEvent,
    encodeSessionCancelCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionEventDeferred,
    encodeSessionEventRejection,
    encodeSessionInfoUpdatedEvent,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    MOBIUS_API_PREFIX,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    SessionEventRejectionCode,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "../../protocol/src/index.ts";
import { AuditStore } from "../src/audit/audit-store.ts";
import { createDaemonConfig, LocalAgentDefinition } from "../src/config.ts";
import { RuntimeRelayRevokedError } from "../src/relay-connection/runtime-revocation.ts";
import { SessionEventOutbox } from "../src/relay-connection/session-event-outbox.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../src/relay-connection/timer.ts";
import { runDaemon } from "../src/run-daemon.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

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

    it("Given one Session fills the reconnect backlog, When the daemon reconnects, Then replay stays bounded and a fresh Session is served in the first batch", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-replay-window-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url === `${MOBIUS_API_PREFIX}/channels/replay-channel/catalog`) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const daemonSockets: Duplex[] = [];
        const observedFrames: ClientWebSocketFrame[] = [];
        const removeObservers: Array<() => void> = [];
        let resolveFirstBatch = (): void => undefined;
        let resolveSecondBatch = (): void => undefined;
        const firstBatch = new Promise<void>((resolve) => {
            resolveFirstBatch = resolve;
        });
        const secondBatch = new Promise<void>((resolve) => {
            resolveSecondBatch = resolve;
        });
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
            removeObservers.push(
                observeClientFrames(socket, (frame) => {
                    if (frame.opcode !== 1) {
                        return;
                    }
                    observedFrames.push(frame);
                    if (observedFrames.length >= 5) {
                        resolveFirstBatch();
                    }
                    if (observedFrames.length >= 6) {
                        resolveSecondBatch();
                    }
                }),
            );
            respondToClientClose(socket);
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const seededOutbox = new SessionEventOutbox(auditDatabasePath);
        for (let sequence = 1; sequence <= 10; sequence += 1) {
            seededOutbox.enqueue(
                "noisy-session",
                JSON.stringify({ kind: "agent.activity", sequence }),
                "noisy-attempt",
            );
        }
        seededOutbox.enqueue("fresh-session", JSON.stringify({ kind: "session.ready" }));
        seededOutbox.close();
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
            channelId: "replay-channel",
            relayUrl: new URL(`ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/replay-channel/daemon`),
        });
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            await firstBatch;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(observedFrames).toHaveLength(5);
            const firstEnvelopes = observedFrames.map((frame) => decodeSessionEventEnvelope(frame.text));
            expect(firstEnvelopes.map((event) => event.sessionId)).toEqual([
                "noisy-session",
                "fresh-session",
                "noisy-session",
                "noisy-session",
                "noisy-session",
            ]);
            const socket = daemonSockets[0];
            if (socket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const firstEnvelope = firstEnvelopes[0];
            if (firstEnvelope === undefined) {
                throw new Error("Test relay did not observe the first Session event");
            }
            writeServerTextFrame(
                socket,
                encodeSessionEventAcknowledgement({
                    cursor: "cursor-0",
                    duplicate: false,
                    eventId: firstEnvelope.eventId,
                    kind: SESSION_EVENT_ACK_KIND,
                    sequence: "1",
                    sessionId: firstEnvelope.sessionId,
                }),
            );
            await secondBatch;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(observedFrames).toHaveLength(6);
            expect(decodeSessionEventEnvelope(observedFrames[5]?.text ?? "").source.sourceSeq).toBe("5");

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(
                    database.prepare("SELECT COUNT(*) AS count FROM relay_session_event_outbox").get(),
                ).toMatchObject({ count: 10 });
            } finally {
                database.close();
            }
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const removeObserver of removeObservers) {
                removeObserver();
            }
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
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given Relay applies archive backpressure to one durable event, When the retry delay expires, Then the daemon resends it on the same connection and retires it only after acknowledgement", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-session-backpressure-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/backpressure-channel/catalog`
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
        const daemonSockets: Duplex[] = [];
        const observedEnvelopes: ReturnType<typeof decodeSessionEventEnvelope>[] = [];
        let removeObserver = (): void => undefined;
        let resolveFirstAttempt = (): void => undefined;
        let resolveRetry = (): void => undefined;
        const firstAttempt = new Promise<void>((resolve) => {
            resolveFirstAttempt = resolve;
        });
        const retry = new Promise<void>((resolve) => {
            resolveRetry = resolve;
        });
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
            removeObserver = observeClientFrames(socket, (frame) => {
                if (frame.opcode !== 1) {
                    return;
                }
                const kind = decodeMessageKind(frame.text);
                if (kind === WORKSPACE_ENTRIES_KIND) {
                    resolveRetry();
                    return;
                }
                if (kind !== SESSION_EVENT_KIND) {
                    return;
                }
                const event = decodeSessionEventEnvelope(frame.text);
                observedEnvelopes.push(event);
                if (observedEnvelopes.length === 1) {
                    writeServerTextFrame(
                        socket,
                        encodeSessionEventDeferred({
                            eventId: event.eventId,
                            kind: SESSION_EVENT_DEFERRED_KIND,
                            retryAfterMilliseconds: 1_000,
                            sessionId: event.sessionId,
                        }),
                    );
                    resolveFirstAttempt();
                    return;
                }
                writeServerTextFrame(
                    socket,
                    encodeSessionEventAcknowledgement({
                        cursor: "backpressure-cursor",
                        duplicate: false,
                        eventId: event.eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                        sequence: "1",
                        sessionId: event.sessionId,
                    }),
                );
                writeServerTextFrame(
                    socket,
                    encodeWorkspaceListCommand({
                        bindingId: "workspace",
                        directoryId: "default",
                        kind: WORKSPACE_LIST_KIND,
                        requestId: "after-session-backpressure",
                    }),
                );
            });
            respondToClientClose(socket);
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const seededOutbox = new SessionEventOutbox(auditDatabasePath);
        seededOutbox.enqueue(
            "backpressure-session",
            JSON.stringify({ kind: "session.info.updated", title: "Long task" }),
        );
        seededOutbox.close();
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const timer = new ControllableDaemonTimer();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
            channelId: "backpressure-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/backpressure-channel/daemon`,
            ),
        });
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstAttempt;
            const retryTask = await timer.waitForTask(1_000);
            expect(daemonSockets).toHaveLength(1);
            retryTask.run();
            await retry;
            expect(observedEnvelopes).toHaveLength(2);
            expect(observedEnvelopes[1]).toEqual(observedEnvelopes[0]);
            expect(daemonSockets).toHaveLength(1);
            expect(daemonSockets[0]?.destroyed).toBe(false);
            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(
                    database.prepare("SELECT COUNT(*) AS count FROM relay_session_event_outbox").get(),
                ).toMatchObject({ count: 0 });
            } finally {
                database.close();
            }
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            removeObserver();
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
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a deleted Session event is durably queued, When the Relay rejects it and sends another command, Then the daemon quarantines the event and remains on the same connection", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-rejected-event-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/rejected-event-channel/catalog`
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
        const upgradeWaiters: Array<() => void> = [];
        const daemonSockets: Duplex[] = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
        let connectionCount = 0;
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
            clientFrames.push(readClientFrame(socket));
            respondToClientClose(socket);
            connectionCount += 1;
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const seededOutbox = new SessionEventOutbox(auditDatabasePath);
        const encodedStaleEnvelope = seededOutbox.enqueue(
            "deleted-session",
            encodeSessionInfoUpdatedEvent({
                kind: SESSION_INFO_UPDATED_KIND,
                sessionId: "deleted-session",
                title: "Stale title",
                updatedAt: "2026-09-08T00:00:00.000Z",
            }),
        );
        const staleEnvelope = decodeSessionEventEnvelope(encodedStaleEnvelope);
        seededOutbox.close();
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
            channelId: "rejected-event-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/rejected-event-channel/daemon`,
            ),
        });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            const firstSocket = daemonSockets[0];
            if (firstFrame === undefined || firstSocket === undefined) {
                throw new Error("Test relay did not observe the daemon connection");
            }
            expect(decodeSessionEventEnvelope((await firstFrame).text)).toEqual(staleEnvelope);

            const commandResponse = readClientFrame(firstSocket);
            writeServerTextFrame(
                firstSocket,
                encodeSessionEventRejection({
                    code: SessionEventRejectionCode.SessionDeleted,
                    eventId: staleEnvelope.eventId,
                    kind: SESSION_EVENT_REJECTED_KIND,
                    sessionId: staleEnvelope.sessionId,
                }),
            );
            writeServerTextFrame(
                firstSocket,
                encodeWorkspaceListCommand({
                    bindingId: "workspace",
                    directoryId: "default",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "after-event-rejection",
                }),
            );
            const response = await commandResponse;
            expect(response.opcode).toBe(1);
            expect(decodeMessageKind(response.text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(connectionCount).toBe(1);

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(
                    database.prepare("SELECT COUNT(*) AS count FROM relay_session_event_outbox").get(),
                ).toMatchObject({ count: 0 });
                expect(
                    database
                        .prepare(
                            `SELECT event_id, session_id, envelope_json, rejection_code
                             FROM relay_session_event_dead_letters`,
                        )
                        .get(),
                ).toMatchObject({
                    event_id: staleEnvelope.eventId,
                    envelope_json: encodedStaleEnvelope,
                    rejection_code: SessionEventRejectionCode.SessionDeleted,
                    session_id: staleEnvelope.sessionId,
                });
                expect(
                    database
                        .prepare(
                            `SELECT command_id, event, session_id, details_json
                             FROM audit_events WHERE event = 'session_event_rejected'`,
                        )
                        .get(),
                ).toMatchObject({
                    command_id: staleEnvelope.eventId,
                    details_json: JSON.stringify({ code: SessionEventRejectionCode.SessionDeleted }),
                    event: "session_event_rejected",
                    session_id: staleEnvelope.sessionId,
                });
            } finally {
                database.close();
            }
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
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
            livenessRequested = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("liveness") === "1";
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

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
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

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                const rows = database
                    .prepare(
                        `SELECT event, details_json
                         FROM audit_events
                         WHERE event IN (
                           'relay_connection_opened',
                           'relay_connection_closed',
                           'relay_heartbeat_timed_out'
                         )
                         ORDER BY id`,
                    )
                    .all();
                expect(
                    rows.map((row) => ({
                        details: JSON.parse(String(Reflect.get(row, "details_json"))),
                        event: Reflect.get(row, "event"),
                    })),
                ).toEqual([
                    {
                        details: expect.objectContaining({ connectionEpoch: "1", proxyRoute: "direct" }),
                        event: "relay_connection_opened",
                    },
                    {
                        details: expect.objectContaining({
                            connectionEpoch: "1",
                            heartbeatId: secondHeartbeat.heartbeatId,
                            timeoutMilliseconds: "10000",
                        }),
                        event: "relay_heartbeat_timed_out",
                    },
                    {
                        details: expect.objectContaining({
                            closeCode: "4001",
                            closeReason: "Relay liveness check timed out",
                            connectionEpoch: "1",
                            source: "heartbeat_timeout",
                        }),
                        event: "relay_connection_closed",
                    },
                    {
                        details: expect.objectContaining({ connectionEpoch: "2", proxyRoute: "direct" }),
                        event: "relay_connection_opened",
                    },
                ]);
            } finally {
                database.close();
            }
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
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given Relay confirmation is lost after a durable delivery receipt, When the daemon reconnects, Then it repeats the same receipt without exposing its credential and retires the command after confirmation", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-delivery-receipt-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let catalogAuthorization = "";
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/delivery-receipt-channel/catalog`
            ) {
                catalogAuthorization = request.headers.authorization ?? "";
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const daemonSockets: Duplex[] = [];
        const receiptFrames: Array<Promise<ClientWebSocketFrame>> = [];
        const upgradeWaiters: Array<() => void> = [];
        const upgradeAuthorizations: string[] = [];
        const upgradeUrls: string[] = [];
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        const delivery = encodeRuntimeDelivery({
            deliveryId: "cancel_delivery_1",
            kind: RUNTIME_DELIVERY_KIND,
            payload: encodeSessionCancelCommand({
                commandId: "inactive-command",
                kind: "session.cancel",
                sessionId: "delivery-receipt-session",
            }),
            sessionId: "delivery-receipt-session",
        });
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
            receiptFrames.push(readClientFrame(socket));
            upgradeAuthorizations.push(request.headers.authorization ?? "");
            upgradeUrls.push(request.url ?? "");
            respondToClientClose(socket);
            if (daemonSockets.length === 1) {
                writeServerTextFrame(socket, delivery);
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const timer = new ControllableDaemonTimer();
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
            auditDatabasePath,
            channelId: "delivery-receipt-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/delivery-receipt-channel/daemon?token=daemon-secret`,
            ),
        });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstConnection;
            const firstReceiptFrame = receiptFrames[0];
            const firstSocket = daemonSockets[0];
            if (firstReceiptFrame === undefined || firstSocket === undefined) {
                throw new Error("Test relay did not retain the first durable receipt connection");
            }
            const firstReceipt = decodeRuntimeDeliveryReceived((await firstReceiptFrame).text);
            expect(firstReceipt).toEqual({
                deliveryId: "cancel_delivery_1",
                kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                sessionId: "delivery-receipt-session",
            });

            const secondConnection = waitForUpgrade();
            writeServerCloseFrame(firstSocket, 1012, "Receipt confirmation interrupted");
            (await timer.waitForTask(500)).run();
            await secondConnection;
            const secondReceiptFrame = receiptFrames[1];
            const secondSocket = daemonSockets[1];
            if (secondReceiptFrame === undefined || secondSocket === undefined) {
                throw new Error("Test relay did not retain the replacement durable receipt connection");
            }
            expect(decodeRuntimeDeliveryReceived((await secondReceiptFrame).text)).toEqual(firstReceipt);

            const barrier = readClientFrame(secondSocket);
            writeServerTextFrame(
                secondSocket,
                encodeRuntimeDeliveryCommitted({
                    deliveryId: firstReceipt.deliveryId,
                    kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                    sessionId: firstReceipt.sessionId,
                }),
            );
            writeServerTextFrame(
                secondSocket,
                encodeWorkspaceListCommand({
                    bindingId: "workspace",
                    directoryId: "default",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "delivery-confirmation-barrier",
                }),
            );
            expect(decodeMessageKind((await barrier).text)).toBe(WORKSPACE_ENTRIES_KIND);

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(database.prepare("SELECT COUNT(*) AS count FROM relay_runtime_deliveries").get()).toEqual({
                    count: 0,
                });
            } finally {
                database.close();
            }
            expect(catalogAuthorization).toBe("Bearer daemon-secret");
            expect(upgradeAuthorizations).toEqual(["Bearer daemon-secret", "Bearer daemon-secret"]);
            expect(upgradeUrls).toEqual([
                `${MOBIUS_API_PREFIX}/channels/delivery-receipt-channel/daemon?deliveryReceipts=1&liveness=1`,
                `${MOBIUS_API_PREFIX}/channels/delivery-receipt-channel/daemon?deliveryReceipts=1&liveness=1`,
            ]);
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given the Relay closes a daemon socket, When the daemon reconnects, Then the audit log preserves both connection epochs and the close code and reason", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-close-audit-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/close-audit-channel/catalog`
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
        const daemonSockets: Duplex[] = [];
        const reconnectedFrames: Array<Promise<ClientWebSocketFrame>> = [];
        const upgradeWaiters: Array<() => void> = [];
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
            if (daemonSockets.length === 2) {
                reconnectedFrames.push(readClientFrame(socket));
                writeServerTextFrame(
                    socket,
                    encodeWorkspaceListCommand({
                        bindingId: "workspace",
                        directoryId: "default",
                        kind: WORKSPACE_LIST_KIND,
                        requestId: "after-relay-maintenance",
                    }),
                );
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const timer = new ControllableDaemonTimer();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
            channelId: "close-audit-channel",
            relayUrl: new URL(
                `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/close-audit-channel/daemon`,
            ),
        });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstConnection;
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the first daemon connection");
            }

            const secondConnection = waitForUpgrade();
            writeServerCloseFrame(firstSocket, 1012, "Relay maintenance");
            (await timer.waitForTask(500)).run();
            await secondConnection;
            const reconnectedFrame = reconnectedFrames[0];
            if (reconnectedFrame === undefined) {
                throw new Error("Test relay did not observe a response on the second daemon connection");
            }
            expect(decodeMessageKind((await reconnectedFrame).text)).toBe(WORKSPACE_ENTRIES_KIND);

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                const rows = database
                    .prepare(
                        `SELECT event, details_json
                         FROM audit_events
                         WHERE event IN ('relay_connection_opened', 'relay_connection_closed')
                         ORDER BY id`,
                    )
                    .all();
                expect(
                    rows.map((row) => ({
                        details: JSON.parse(String(Reflect.get(row, "details_json"))),
                        event: Reflect.get(row, "event"),
                    })),
                ).toEqual([
                    {
                        details: expect.objectContaining({ connectionEpoch: "1" }),
                        event: "relay_connection_opened",
                    },
                    {
                        details: expect.objectContaining({
                            closeCode: "1012",
                            closeReason: "Relay maintenance",
                            connectionEpoch: "1",
                            source: "relay",
                        }),
                        event: "relay_connection_closed",
                    },
                    {
                        details: expect.objectContaining({ connectionEpoch: "2" }),
                        event: "relay_connection_opened",
                    },
                ]);
            } finally {
                database.close();
            }
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
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
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

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
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
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent emits many snapshots for one activity, When the daemon records the turn, Then it coalesces intermediate snapshots and preserves the final activity", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-activity-coalescing-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MOBIUS_API_PREFIX}/channels/activity-coalescing-channel/catalog`
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
        const activities: Array<ReturnType<typeof decodeAgentActivityEvent>> = [];
        let agentText = "";
        let removeObserver = (): void => undefined;
        let eventSequence = 0;
        let resolveCompleted = (): void => undefined;
        const completed = new Promise<void>((resolve) => {
            resolveCompleted = resolve;
        });
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
            removeObserver = observeClientFrames(socket, (frame) => {
                if (frame.opcode !== 1 || decodeMessageKind(frame.text) !== SESSION_EVENT_KIND) {
                    return;
                }
                const envelope = decodeSessionEventEnvelope(frame.text);
                eventSequence += 1;
                writeServerTextFrame(
                    socket,
                    encodeSessionEventAcknowledgement({
                        cursor: `activity-cursor-${eventSequence.toString()}`,
                        duplicate: false,
                        eventId: envelope.eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                        sequence: eventSequence.toString(),
                        sessionId: envelope.sessionId,
                    }),
                );
                const kind = decodeMessageKind(envelope.payload);
                if (kind === AGENT_ACTIVITY_KIND) {
                    activities.push(decodeAgentActivityEvent(envelope.payload));
                    return;
                }
                if (kind === AGENT_MESSAGE_DELTA_KIND) {
                    agentText += decodeAgentMessageDeltaEvent(envelope.payload).text;
                    return;
                }
                if (kind === SESSION_COMPLETED_KIND) {
                    resolveCompleted();
                }
            });
            respondToClientClose(socket);
            writeServerTextFrame(
                socket,
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId: "activity-coalescing-command",
                    directoryId: "default",
                    disposition: "reject",
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "stream verbose activity",
                    resources: [],
                    sessionId: "activity-coalescing-session",
                    targetCommandId: "",
                }),
            );
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
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
                auditDatabasePath,
                channelId: "activity-coalescing-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/activity-coalescing-channel/daemon`,
                ),
            },
            [new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath])],
        );

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await completed;
            const reasoning = activities.filter((activity) => activity.activityType === "reasoning");
            expect(activities).toHaveLength(6);
            expect(reasoning).toHaveLength(2);
            expect(reasoning.map((activity) => activity.status)).toEqual(["running", "completed"]);
            expect(reasoning.at(-1)?.output).toContain("step-63");
            expect(agentText).toBe("Echo from ACP: stream verbose activity");
        } finally {
            cancellation.abort();
            await daemon;
            removeObserver();
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

    it("Given a healthy idle daemon connection, When twenty minutes pass, Then the same relay connection remains available", async () => {
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

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MOBIUS_COPILOT_PATH"] = join(stateDirectory, "missing-copilot");
        process.env["MOBIUS_HERMES_PATH"] = join(stateDirectory, "missing-hermes");
        process.env["MOBIUS_GEMINI_PATH"] = join(stateDirectory, "missing-gemini");
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createDaemonConfig({
            defaultWorkspace,
            auditDatabasePath,
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
                requestedUrls: [`${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon?deliveryReceipts=1&liveness=1`],
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
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an active Agent turn cannot be reconciled, When its relay connection recovers, Then the daemon replaces the connection without exiting", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-reconciliation-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let reconciliationRequestCount = 0;
        let reconciliationAuthorization = "";
        let reconciliationSearch = "";
        let observeReconciliationFailure = (): void => undefined;
        const reconciliationFailure = new Promise<void>((resolve) => {
            observeReconciliationFailure = resolve;
        });
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
                reconciliationAuthorization = request.headers.authorization ?? "";
                reconciliationSearch = url.search;
                request.resume();
                response.writeHead(503, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: {
                            code: "session_storage_unavailable",
                            message: "The test Relay temporarily rejected reconciliation",
                        },
                    }),
                );
                observeReconciliationFailure();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        const daemonSockets: Duplex[] = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
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
            if (daemonSockets.length === 1) {
                clientFrames.push(readClientFrame(socket));
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
                        prompt: "exercise ACP controls",
                        resources: [],
                        sessionId: "reconciliation-session",
                        targetCommandId: "",
                    }),
                );
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
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
                auditDatabasePath,
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
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the active Agent turn");
            }
            const started = decodeSessionEventEnvelope((await firstFrame).text);
            expect(decodeMessageKind(started.payload)).toBe(SESSION_STARTED_KIND);
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the first connection");
            }

            const secondConnection = waitForUpgrade();
            const firstRetry = timer.waitForTask(500);
            firstSocket.destroy();
            (await firstRetry).run();
            await secondConnection;
            const secondRetry = timer.waitForTask(500);
            await reconciliationFailure;
            expect(reconciliationRequestCount).toBe(1);
            expect(reconciliationAuthorization).toBe("Bearer reconciliation-secret");
            expect(reconciliationSearch).toBe("");

            const thirdConnection = waitForUpgrade();
            (await secondRetry).run();
            await thirdConnection;
            expect(daemonSockets).toHaveLength(3);
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

    it("Given the Relay already settled an active Agent turn, When the connection recovers, Then the daemon abandons the turn instead of replacing the connection forever", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-reconciliation-conflict-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let reconciliationRequestCount = 0;
        let observeAbandonment = (): void => undefined;
        const abandonmentSettled = new Promise<void>((resolve) => {
            observeAbandonment = resolve;
        });
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
                response.writeHead(409, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: {
                            code: "session_conflict",
                            message: "The Attempt cannot be reconciled from its current state",
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
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
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
            observeClientFrames(socket, (frame) => {
                // The abandoned turn is published only after the Relay rejected its reconciliation.
                if (
                    frame.opcode === 1 &&
                    reconciliationRequestCount > 0 &&
                    decodeMessageKind(frame.text) === SESSION_EVENT_KIND
                ) {
                    observeAbandonment();
                }
            });
            if (daemonSockets.length === 1) {
                clientFrames.push(readClientFrame(socket));
                writeServerTextFrame(
                    socket,
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: "workspace",
                        commandId: "conflict-command",
                        directoryId: "default",
                        disposition: "reject",
                        images: [],
                        kind: SESSION_PROMPT_KIND,
                        prompt: "wait until cancelled",
                        resources: [],
                        sessionId: "conflict-session",
                        targetCommandId: "",
                    }),
                );
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);

        const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
        const audit = new AuditStore(auditDatabasePath);
        const cancellation = new AbortController();
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
                auditDatabasePath,
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
        const daemon = runDaemon(config, audit, cancellation.signal, timer);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the active Agent turn");
            }
            const started = decodeSessionEventEnvelope((await firstFrame).text);
            expect(decodeMessageKind(started.payload)).toBe(SESSION_STARTED_KIND);
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the first connection");
            }

            const secondConnection = waitForUpgrade();
            const firstRetry = timer.waitForTask(500);
            firstSocket.destroy();
            (await firstRetry).run();
            await secondConnection;

            // The Relay settled the Attempt, so the recovered connection stays usable instead of being
            // replaced by another 4009 reconnect cycle.
            await abandonmentSettled;
            expect(reconciliationRequestCount).toBe(1);
            expect(daemonSockets).toHaveLength(2);

            const diagnostics = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                const abandoned = diagnostics
                    .prepare("SELECT details_json FROM audit_events WHERE event = 'relay_reconciliation_abandoned'")
                    .all()
                    .map((row) => String(row["details_json"]))
                    .join("\n");
                expect(abandoned).toContain("session_conflict");
                const closed = diagnostics
                    .prepare("SELECT details_json FROM audit_events WHERE event = 'relay_connection_closed'")
                    .all()
                    .map((row) => String(row["details_json"]))
                    .join("\n");
                expect(closed).not.toContain("4009");
            } finally {
                diagnostics.close();
            }
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
