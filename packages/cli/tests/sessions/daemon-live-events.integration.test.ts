import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveEventEnvelopeV3,
    decodeSessionLiveHistoryV2PageLoaded,
    decodeSessionReadyEvent,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    SESSION_LIVE_V3_KIND,
    type SessionEventV2,
    type SessionLiveEventV3,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS } from "../../src/relay-connection/session-event-publisher.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../../src/relay-connection/timer.ts";
import { runDaemon } from "../../src/run-daemon.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class ControllableDaemonTask implements DaemonScheduledTask {
    #cancelled = false;
    readonly #callback: () => void;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (!this.#cancelled) {
            this.#cancelled = true;
            this.#callback();
        }
    };
}

class ControllableDaemonTimer implements DaemonTimer {
    readonly batchWindowMilliseconds: number[] = [];
    readonly #scheduled: ControllableDaemonTask[] = [];
    readonly #waiters: Array<(task: ControllableDaemonTask) => void> = [];

    readonly schedule = (callback: () => void, milliseconds: number): DaemonScheduledTask => {
        const task = new ControllableDaemonTask(callback);
        if (milliseconds !== SESSION_EVENT_V2_BATCH_WINDOW_MILLISECONDS) {
            return task;
        }
        this.batchWindowMilliseconds.push(milliseconds);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#scheduled.push(task);
        } else {
            waiter(task);
        }
        return task;
    };

    readonly nextBatch = (): Promise<ControllableDaemonTask> => {
        const task = this.#scheduled.shift();
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
    };
}

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

    readonly take = (): string | null => this.#messages.shift() ?? null;
}

async function startControlledDaemon(
    createAgent?: (stateDirectory: string, workspace: string) => Promise<LocalAgentDefinition>,
): Promise<{
    readonly agent: LocalAgentDefinition;
    readonly close: () => Promise<void>;
    readonly config: ReturnType<typeof createDaemonConfig>;
    readonly frames: ClientFrames;
    readonly liveBatchSizes: number[];
    readonly socket: Duplex;
    readonly timer: ControllableDaemonTimer;
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
    const agent =
        createAgent === undefined
            ? new LocalAgentDefinition(
                  "opencode",
                  "OpenCode",
                  process.execPath,
                  [fakeAgentPath, "--agent-name", "OpenCode"],
                  { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
              )
            : await createAgent(stateDirectory, workspace);
    const config = createDaemonConfig(
        { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const timer = new ControllableDaemonTimer();
    const daemon = runDaemon(config, audit, cancellation.signal, timer);
    const socket = await socketReady.promise;
    return {
        agent,
        config,
        frames: new ClientFrames(socket),
        liveBatchSizes: [],
        socket,
        timer,
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

type Fixture = Awaited<ReturnType<typeof startControlledDaemon>>;
const pendingLiveEvents = new WeakMap<Fixture, SessionEventV2[]>();
function prompt(fixture: Fixture, text: string): SessionPromptCommand {
    return {
        additionalDirectoryIds: [],
        agentId: fixture.agent.id,
        bindingId: fixture.config.bindingId,
        commandId: "test-turn",
        directoryId: "default",
        disposition: SessionPromptDisposition.Reject,
        images: [],
        kind: "session.prompt",
        prompt: text,
        resources: [],
        sessionId: "test-session",
        targetCommandId: "",
    };
}
async function nextLive(fixture: Fixture): Promise<SessionEventV2> {
    const pending = pendingLiveEvents.get(fixture) ?? [];
    const buffered = pending.shift();
    if (buffered !== undefined) {
        return buffered;
    }
    const task = await fixture.timer.nextBatch();
    task.run();
    for (;;) {
        const frame = await fixture.frames.next();
        expect(decodeMessageKind(frame)).not.toBe("session.event");
        if (decodeMessageKind(frame) === "session.operation.failed") {
            throw new Error(frame);
        }
        if (decodeMessageKind(frame) !== SESSION_EVENT_V2_KIND) {
            continue;
        }
        const events = [...decodeSessionEventEnvelopeV2(frame).events];
        fixture.liveBatchSizes.push(events.length);
        const failure = events.find(
            (event) =>
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start"),
        );
        if (failure !== undefined) {
            throw new Error(frame);
        }
        const event = events.shift();
        if (event !== undefined) {
            pendingLiveEvents.set(fixture, events);
            return event;
        }
    }
}
async function cancel(fixture: Fixture, command: SessionPromptCommand): Promise<void> {
    sendText(
        fixture.socket,
        encodeSessionCancelCommand({
            kind: "session.cancel",
            commandId: command.commandId,
            sessionId: command.sessionId,
        }),
    );
    for (;;) {
        const event = await nextLive(fixture);
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.stopReason).toBe("cancelled");
            return;
        }
    }
}
async function history(
    fixture: Fixture,
    command: SessionPromptCommand,
    options: { readonly eventLimit?: number; readonly omit?: readonly "agent-reasoning"[] } = {},
) {
    sendText(
        fixture.socket,
        encodeSessionLiveHistoryV2PageLoad({
            kind: "session.live-history.v2.page.load",
            requestId: "history",
            sessionId: command.sessionId,
            cursor: null,
            eventLimit: options.eventLimit ?? 200,
            ...(options.omit === undefined ? {} : { omit: options.omit }),
        }),
    );
    for (;;) {
        const frame = await fixture.frames.next();
        if (decodeMessageKind(frame) === "session.operation.failed") {
            throw new Error(frame);
        }
        if (decodeMessageKind(frame) === SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND) {
            return decodeSessionLiveHistoryV2PageLoaded(frame).events.events;
        }
    }
}
function deliveryIdentity(event: SessionEventV2): unknown {
    return {
        eventId: event.eventId,
        payload:
            event.type === "acp" && event.payload.sessionUpdate === "tool_call_update"
                ? { sessionUpdate: event.payload.sessionUpdate, toolCallId: event.payload.toolCallId }
                : event.payload,
        type: event.type,
    };
}
async function activeTurn(fixture: Fixture, command: SessionPromptCommand) {
    sendText(
        fixture.socket,
        encodeNativeSessionRequest({
            action: "active-turn",
            additionalDirectoryIds: [],
            agentId: fixture.agent.id,
            bindingId: fixture.config.bindingId,
            directoryId: "default",
            kind: "native.session.request",
            requestId: "active",
            sessionId: command.sessionId,
            targetSessionId: command.sessionId,
        }),
    );
    for (;;) {
        const frame = await fixture.frames.next();
        if (decodeMessageKind(frame) !== NATIVE_SESSION_RESULT_KIND) {
            continue;
        }
        const result = decodeNativeSessionResult(frame);
        if (result.action !== "active-turn") {
            throw new Error("Expected active turn");
        }
        return result.turn;
    }
}
describe("daemon V2 live delivery", () => {
    it("Given reasoning chunks exceed a 200-event page, When history omits reasoning details, Then 200 events remain and each marker retains its chunk's first position", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream paged reasoning");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
            const complete = await history(fixture, command, { eventLimit: 1_000 });
            const firstReasoningPositions = new Map<string, string>();
            for (const event of complete.events) {
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_thought_chunk" &&
                    typeof event.payload.messageId === "string" &&
                    !firstReasoningPositions.has(event.payload.messageId)
                ) {
                    firstReasoningPositions.set(event.payload.messageId, event.position);
                }
            }

            const omitted = await history(fixture, command, { eventLimit: 200, omit: ["agent-reasoning"] });
            const retainedReasoning = omitted.events.filter(
                (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
            );

            expect(omitted.events).toHaveLength(200);
            expect(retainedReasoning.length).toBeGreaterThan(0);
            for (const event of retainedReasoning) {
                if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
                    throw new Error("Expected retained reasoning");
                }
                expect(event.mobiusMetadata).toEqual({ omitted: true });
                expect(event.payload.content).toEqual({ text: "", type: "text" });
                expect(event.position).toBe(firstReasoningPositions.get(event.payload.messageId ?? ""));
            }
        } finally {
            await fixture.close();
        }
    });
    it("Given text surrounds a tool call, When a viewer reopens live history, Then the streamed and recovered events preserve the same order", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "interleave progress and hold");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            const live: SessionEventV2[] = [];
            const order: string[] = [];
            let accumulated = "";
            for (;;) {
                const event = await nextLive(fixture);
                live.push(event);
                if (event.type !== "acp") {
                    continue;
                }
                const update = event.payload;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    if (update.content.text.includes("Checking the workspace")) {
                        order.push("first-message");
                    }
                    accumulated += update.content.text;
                    if (accumulated.includes("OpenCode turn 1: interleave progress and hold")) {
                        order.push("final-message");
                        break;
                    }
                }
                if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
                    order.push("tool");
                }
            }
            expect(order).toEqual(["first-message", "tool", "final-message"]);
            const page = await history(fixture, command);
            expect(page.events.map(deliveryIdentity)).toEqual(expect.arrayContaining(live.map(deliveryIdentity)));
            const active = await activeTurn(fixture, command);
            expect(active?.messages.some((message) => message.text.includes("OpenCode turn 1:"))).toBe(true);
            await cancel(fixture, command);
        } finally {
            await fixture.close();
        }
    });

    it("Given cumulative tool updates, When a viewer reopens history, Then prior cursor positions are retained without duplicate output", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream cumulative tool output");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }

            const page = await history(fixture, command);
            const updates = page.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "tool_call_update" ? [event] : [],
            );
            expect(updates.map((event) => event.payload)).toEqual([
                { sessionUpdate: "tool_call_update", toolCallId: "tool-1" },
                { sessionUpdate: "tool_call_update", toolCallId: "tool-1" },
                expect.objectContaining({
                    content: [{ content: { text: "rendered snapshot", type: "text" }, type: "content" }],
                    rawOutput: { output: "final snapshot" },
                    sessionUpdate: "tool_call_update",
                    status: "completed",
                    toolCallId: "tool-1",
                }),
            ]);
            expect(updates.map((event) => event.position)).toEqual(
                updates.map((event) => event.position).toSorted((left, right) => Number(left) - Number(right)),
            );
        } finally {
            await fixture.close();
        }
    });
    it("Given token-sized chunks, When the turn completes, Then every token arrives once and live event identities match recovery", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream token burst");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            const live: SessionEventV2[] = [];
            let text = "";
            for (;;) {
                const event = await nextLive(fixture);
                live.push(event);
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toBe(
                `Gathering contextOpenCode turn 1: ${Array.from({ length: 64 }, (_, index) => `token-${index} `).join("")}`,
            );
            expect(fixture.timer.batchWindowMilliseconds).toContain(100);
            expect(fixture.liveBatchSizes.some((size) => size > 1)).toBe(true);
            const page = await history(fixture, command);
            expect(page.events.map(deliveryIdentity)).toEqual(live.map(deliveryIdentity));
        } finally {
            await fixture.close();
        }
    });
    it("Given a 300k character current turn, When a viewer opens history and then cancels, Then recovery contains the complete output and the active turn is released", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "hold after large output");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            let text = "";
            while (text.length < 300_000) {
                const event = await nextLive(fixture);
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    if (event.payload.content.text !== "Gathering context") {
                        text += event.payload.content.text;
                    }
                }
            }
            expect(text).toBe("x".repeat(300_000));
            expect(await activeTurn(fixture, command)).not.toBeNull();
            const page = await history(fixture, command);
            expect(page.truncated).toBe(false);
            const recovered = page.events
                .flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                )
                .join("");
            expect(recovered).toBe(`Gathering context${text}`);
            await cancel(fixture, command);
            expect(await activeTurn(fixture, command)).toBeNull();
        } finally {
            await fixture.close();
        }
    });
});

describe("daemon V3 direct Codex delivery", () => {
    it("Given a production Codex command, When the daemon prepares, prompts, and cancels it, Then native lifecycle and content use one persistent sequence", async () => {
        const fixture = await startControlledDaemon(async (stateDirectory) => {
            const executable = join(stateDirectory, "codex");
            await writeFile(
                executable,
                `#!${process.execPath}
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.154.0\\n");
    process.exit(0);
}
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === "initialized") continue;
    if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
        continue;
    }
    if (request.method === "thread/start") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "native-daemon-thread" } } }) + "\\n");
        continue;
    }
    if (request.method === "turn/start") {
        turn += 1;
        const turnId = "turn-" + turn;
        process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: request.params.threadId, turn: { id: turnId, status: "inProgress" } } }) + "\\n");
        if (turn === 1) {
            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "native answer", itemId: "message-1", threadId: request.params.threadId, turnId } }) + "\\n");
            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: turnId, status: "completed" } } }) + "\\n");
        }
        continue;
    }
    if (request.method === "turn/interrupt") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: request.params.turnId, status: "interrupted" } } }) + "\\n");
        continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unexpected method" } }) + "\\n");
}
`,
                { mode: 0o700 },
            );
            await chmod(executable, 0o700);
            const discovered = new LocalAgentDefinition("codex", "Codex", executable, [], {}, "", "0.154.0");
            return new LocalAgentDefinition(
                discovered.id,
                discovered.label,
                discovered.command,
                discovered.arguments,
                discovered.environment,
                discovered.adapterVersion,
                discovered.agentVersion,
                discovered.adapterIdentity,
                discovered.agentIdentity,
                discovered.capabilities,
                true,
            );
        });
        const nextV3 = async () => {
            for (;;) {
                let frame = fixture.frames.take();
                if (frame === null) {
                    const task = await fixture.timer.nextBatch();
                    task.run();
                    frame = await fixture.frames.next();
                }
                for (;;) {
                    const kind = decodeMessageKind(frame);
                    if (kind === "session.operation.failed") {
                        throw new Error(frame);
                    }
                    if (kind === SESSION_LIVE_V3_KIND) {
                        return decodeSessionLiveEventEnvelopeV3(frame).events;
                    }
                    if (kind === SESSION_EVENT_V2_KIND) {
                        break;
                    }
                    frame = await fixture.frames.next();
                }
            }
        };
        try {
            sendText(
                fixture.socket,
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: fixture.config.bindingId,
                    directoryId: "default",
                    kind: "session.prepare",
                    requestId: "prepare-v3-codex",
                    sessionId: "test-session",
                }),
            );
            for (;;) {
                const ready = await fixture.frames.next();
                if (decodeMessageKind(ready) === "session.operation.failed") {
                    throw new Error(ready);
                }
                if (decodeMessageKind(ready) === "session.ready") {
                    expect(decodeSessionReadyEvent(ready).sessionProtocolVersion).toBe(3);
                    break;
                }
            }
            const connected = await nextV3();
            expect(connected).toMatchObject([
                {
                    seq: 1,
                    item: { sessionUpdate: "session_lifecycle_changed", state: { kind: "connected" } },
                },
            ]);

            const first = { ...prompt(fixture, "first native prompt"), commandId: "native-turn-1" };
            sendText(fixture.socket, encodeSessionPromptCommand(first));
            const completed: SessionLiveEventV3[] = [];
            while (
                !completed.some(
                    (event) =>
                        event.item.sessionUpdate === "session_lifecycle_changed" && event.item.state.kind === "idle",
                )
            ) {
                completed.push(...(await nextV3()));
            }
            expect(completed.map((event) => event.seq)).toEqual([2, 3, 4]);
            expect(completed.map((event) => event.item)).toMatchObject([
                { sessionUpdate: "session_lifecycle_changed", state: { kind: "running" } },
                { content: { text: "native answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
                { sessionUpdate: "session_lifecycle_changed", state: { kind: "idle" } },
            ]);

            const second = { ...prompt(fixture, "cancel native prompt"), commandId: "native-turn-2" };
            sendText(fixture.socket, encodeSessionPromptCommand(second));
            const running = await nextV3();
            expect(running).toMatchObject([
                {
                    seq: 5,
                    item: { sessionUpdate: "session_lifecycle_changed", state: { kind: "running" } },
                },
            ]);
            sendText(
                fixture.socket,
                encodeSessionCancelCommand({
                    commandId: second.commandId,
                    kind: "session.cancel",
                    sessionId: second.sessionId,
                }),
            );
            const cancelled = await nextV3();
            expect(cancelled).toMatchObject([
                {
                    seq: 6,
                    item: { sessionUpdate: "session_lifecycle_changed", state: { kind: "idle" } },
                },
            ]);
        } finally {
            await fixture.close();
        }
    });
});
