import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionEventDeferred,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    RUNTIME_LIVENESS_READY_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_KIND,
    SESSION_PROMPT_KIND,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it, vi } from "vitest";
import { LocalAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig } from "../../../packages/cli/src/config.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../../../packages/cli/src/relay-connection/timer.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port, sendText } from "../../../tests/infra/websocket.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const RETRY_AFTER_MILLISECONDS = 1_000;
const DIAGNOSTIC_PREFIX = "Mobius relay diagnostic ";
const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function restoreEnvironmentVariable(name: string, previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = previous;
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
        if (!this.#cancelled) {
            this.#callback();
        }
    };
}

/** Deterministic daemon timer so a deferred replay never depends on wall-clock waiting. */
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
        this.#scheduled.set(milliseconds, [...(this.#scheduled.get(milliseconds) ?? []), task]);
        return task;
    };

    readonly waitForTask = (milliseconds: number): Promise<ControllableDaemonTask> => {
        const task = this.#scheduled.get(milliseconds)?.shift();
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve) => {
            this.#waiters.set(milliseconds, [...(this.#waiters.get(milliseconds) ?? []), resolve]);
        });
    };
}

/** Reads one masked client WebSocket frame from a controlled Relay socket. */
function readClientFrame(socket: Duplex): Promise<string> {
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
        const handleClose = (): void => fail(new Error("The daemon connection closed before sending a frame"));
        const handleData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.byteLength < 6) {
                return;
            }
            const encodedLength = buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                fail(new Error("The controlled Relay received an oversized daemon frame"));
                return;
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? buffered.readUInt16BE(2) : encodedLength;
            if (buffered.byteLength < headerLength + 4 + payloadLength) {
                return;
            }
            const mask = buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(buffered.subarray(headerLength + 4, headerLength + 4 + payloadLength));
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            cleanup();
            resolve(payload.toString("utf8"));
        };
        socket.once("close", handleClose);
        socket.on("data", handleData);
        socket.once("error", fail);
    });
}

describe("daemon Session event backlog", () => {
    it("Given the Relay defers an acknowledgement because Recording cannot keep up, When the daemon keeps the event, Then the daemon reports its durable outbox backlog and replays it", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-outbox-backlog-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const sockets = new Set<Duplex>();
        const daemonSockets: Duplex[] = [];
        const connected = Promise.withResolvers<Duplex>();
        const firstEvent = Promise.withResolvers<{ readonly eventId: string; readonly sessionId: string }>();
        const relay = createServer((request, response) => {
            if (request.url?.endsWith("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
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
            socket.write(
                `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${createHash(
                    "sha1",
                )
                    .update(`${key}${WEBSOCKET_GUID}`)
                    .digest("base64")}\r\n\r\n`,
            );
            socket.on("error", () => undefined);
            daemonSockets.push(socket);
            connected.resolve(socket);
            sendText(
                socket,
                encodeRuntimeLivenessReadyEvent({
                    kind: RUNTIME_LIVENESS_READY_KIND,
                    sessionEventDelivery: "reliable-v1",
                }),
            );
            void (async () => {
                for (;;) {
                    const frame = await readClientFrame(socket);
                    if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    const envelope = decodeSessionEventEnvelope(frame);
                    if (!("delivery" in envelope)) {
                        continue;
                    }
                    firstEvent.resolve({ eventId: envelope.delivery.eventId, sessionId: envelope.sessionId });
                    return;
                }
            })().catch(() => undefined);
        });
        await listen(relay);
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/backlog-channel/daemon`);
        relayUrl.searchParams.set("token", "b".repeat(43));

        const audit = new AuditStore();
        const cancellation = new AbortController();
        const timer = new ControllableDaemonTimer();
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousFakeAcpStateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = join(stateDirectory, "native");
        const config = createDaemonConfig({ channelId: "backlog-channel", defaultWorkspace, relayUrl }, [
            new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath, "--agent-name", "Codex"]),
        ]);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
        const daemon = runDaemon(config, audit, cancellation.signal, timer);
        try {
            const socket = await connected.promise;
            sendText(
                socket,
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId: "backlog-command",
                    directoryId: "default",
                    disposition: "reject",
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "stream verbose activity",
                    resources: [],
                    sessionId: "backlog-session",
                    targetCommandId: "",
                }),
            );
            const pending = await firstEvent.promise;
            // Half a second of unacknowledged work is what the reported age must reflect.
            vi.setSystemTime(new Date("2026-09-30T00:00:00.500Z"));
            sendText(
                socket,
                encodeSessionEventDeferred({
                    eventId: pending.eventId,
                    kind: SESSION_EVENT_DEFERRED_KIND,
                    retryAfterMilliseconds: RETRY_AFTER_MILLISECONDS,
                    sessionId: pending.sessionId,
                }),
            );
            // The daemon schedules the deferred replay only after it has recorded its backlog.
            const replay = await timer.waitForTask(RETRY_AFTER_MILLISECONDS);
            replay.run();
            const replayed = await firstReliableEventFrame(socket);
            expect(decodeSessionEventEnvelope(replayed)).toMatchObject({
                delivery: { eventId: pending.eventId },
                sessionId: pending.sessionId,
            });

            const backlog = await readBacklogDiagnostic(join(stateDirectory, "logs", "daemon.log"));
            expect(backlog).toMatchObject({
                channelId: "backlog-channel",
                deadLetters: "0",
                event: "session_event_outbox_backlog",
                oldestEventAgeMilliseconds: "500",
                // session.ready plus the Turn's session.started remain unacknowledged while Recording is saturated.
                pendingEvents: "2",
            });
            expect(Number(backlog["pendingBytes"])).toBeGreaterThan(0);
            expect(Number(backlog["standardEventBytes"])).toBe(96 * 1024 * 1024);

            // One deferred acknowledgement reports the backlog once; the replay itself is the recovery path.
            expect(await countBacklogDiagnostics(join(stateDirectory, "logs", "daemon.log"))).toBe(1);
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            vi.useRealTimers();
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("MOBIUS_FAKE_ACP_STATE_DIRECTORY", previousFakeAcpStateDirectory);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});

describe("daemon Session event outbox upgrade", () => {
    it("Given a persisted outbox written before events were timestamped, When the daemon restarts, Then it replays the pending event and reports its backlog without inventing an age", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-outbox-legacy-"));
        const defaultWorkspace = join(stateDirectory, "workspace");
        const eventsDirectory = join(stateDirectory, "events");
        await Promise.all([mkdir(defaultWorkspace), mkdir(eventsDirectory, { recursive: true })]);
        const channelId = "legacy-outbox-channel";
        const outboxPath = join(eventsDirectory, `${createHash("sha256").update(channelId).digest("hex")}.sqlite`);
        const streamId = "legacy-stream";
        const pendingEvent = encodeSessionEventEnvelope({
            delivery: { eventId: "legacy-event", kind: "reliable", sourceSeq: "1", streamId },
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({ kind: "session.queue.changed", sessionId: "legacy-session" }),
            sessionId: "legacy-session",
        });
        // The schema a daemon persisted before enqueue timestamps existed, with an unacknowledged event.
        const legacy = new DatabaseSync(outboxPath);
        legacy.exec(`
            CREATE TABLE relay_session_event_outbox (
                ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                source_seq INTEGER NOT NULL UNIQUE,
                byte_length INTEGER NOT NULL,
                envelope_json TEXT NOT NULL
            ) STRICT;
            CREATE INDEX relay_session_event_outbox_order ON relay_session_event_outbox(source_seq);
            CREATE TABLE relay_session_event_outbox_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                stream_id TEXT NOT NULL,
                next_source_seq INTEGER NOT NULL,
                total_bytes INTEGER NOT NULL
            ) STRICT;
            INSERT INTO relay_session_event_outbox_state (singleton, stream_id, next_source_seq, total_bytes)
                VALUES (1, '${streamId}', 2, ${pendingEvent.length.toString()});
        `);
        legacy
            .prepare(
                `INSERT INTO relay_session_event_outbox (
                    event_id, session_id, source_seq, byte_length, envelope_json
                ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run("legacy-event", "legacy-session", 1, pendingEvent.length, pendingEvent);
        legacy.close();

        const sockets = new Set<Duplex>();
        const connected = Promise.withResolvers<Duplex>();
        const firstEvent = Promise.withResolvers<{ readonly eventId: string; readonly sessionId: string }>();
        const relay = createServer((_request, response) => {
            response.writeHead(426);
            response.end();
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
            socket.write(
                `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${createHash(
                    "sha1",
                )
                    .update(`${key}${WEBSOCKET_GUID}`)
                    .digest("base64")}\r\n\r\n`,
            );
            socket.on("error", () => undefined);
            connected.resolve(socket);
            sendText(
                socket,
                encodeRuntimeLivenessReadyEvent({
                    kind: RUNTIME_LIVENESS_READY_KIND,
                    sessionEventDelivery: "reliable-v1",
                }),
            );
            void (async () => {
                for (;;) {
                    const frame = await readClientFrame(socket);
                    if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    const envelope = decodeSessionEventEnvelope(frame);
                    if (!("delivery" in envelope)) {
                        continue;
                    }
                    firstEvent.resolve({ eventId: envelope.delivery.eventId, sessionId: envelope.sessionId });
                    return;
                }
            })().catch(() => undefined);
        });
        await listen(relay);
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/${channelId}/daemon`);
        relayUrl.searchParams.set("token", "l".repeat(43));

        const audit = new AuditStore();
        const cancellation = new AbortController();
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        const config = createDaemonConfig({ channelId, defaultWorkspace, relayUrl }, [
            new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath, "--agent-name", "Codex"]),
        ]);
        const daemon = runDaemon(config, audit, cancellation.signal);
        try {
            const socket = await connected.promise;
            const replayed = await firstReliableEventFrame(socket);
            expect(decodeSessionEventEnvelope(replayed)).toMatchObject({
                delivery: { eventId: "legacy-event", sourceSeq: "1", streamId },
                sessionId: "legacy-session",
            });

            sendText(
                socket,
                encodeSessionEventDeferred({
                    eventId: "legacy-event",
                    kind: SESSION_EVENT_DEFERRED_KIND,
                    retryAfterMilliseconds: RETRY_AFTER_MILLISECONDS,
                    sessionId: "legacy-session",
                }),
            );
            const backlog = await readBacklogDiagnostic(join(stateDirectory, "logs", "daemon.log"));
            expect(backlog).toMatchObject({
                deadLetters: "0",
                event: "session_event_outbox_backlog",
                // An event persisted before timestamps existed must not be reported with a fabricated age.
                oldestEventAgeMilliseconds: "0",
                pendingBytes: String(pendingEvent.length),
                pendingEvents: "1",
            });
            const columns = new DatabaseSync(outboxPath)
                .prepare(`SELECT name FROM pragma_table_info('relay_session_event_outbox')`)
                .all()
                .map((row) => String(row["name"]));
            expect(columns).toContain("created_at");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});

async function firstReliableEventFrame(socket: Duplex): Promise<string> {
    for (;;) {
        const frame = await readClientFrame(socket);
        if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
            continue;
        }
        if ("delivery" in decodeSessionEventEnvelope(frame)) {
            return frame;
        }
    }
}

async function backlogDiagnostics(path: string): Promise<readonly Readonly<Record<string, string>>[]> {
    return (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith(DIAGNOSTIC_PREFIX) && line.includes("session_event_outbox_backlog"))
        .map((line) => JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)) as Readonly<Record<string, string>>);
}

const countBacklogDiagnostics = async (path: string): Promise<number> => (await backlogDiagnostics(path)).length;

/** Reads the newest durable outbox backlog diagnostic the daemon recorded. */
async function readBacklogDiagnostic(path: string): Promise<Readonly<Record<string, string>>> {
    const diagnostics = await backlogDiagnostics(path);
    const newest = diagnostics.at(-1);
    if (newest === undefined) {
        throw new Error("The daemon did not report a Session event outbox backlog");
    }
    return newest;
}
