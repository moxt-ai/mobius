import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_EVENT_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    type SessionEvent,
    type SessionLiveEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../src/runtime/config.ts";
import { SESSION_EVENT_BATCH_WINDOW_MILLISECONDS } from "../../src/runtime/relay/session-event-publisher.ts";
import { runRuntime } from "../../src/runtime/run.ts";
import type { ScheduledTask, Timer } from "../../src/util/timer.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class ControllableDaemonTask implements ScheduledTask {
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

class ControllableTimer implements Timer {
    readonly batchWindowMilliseconds: number[] = [];
    readonly #scheduled: ControllableDaemonTask[] = [];
    readonly #waiters: Array<(task: ControllableDaemonTask) => void> = [];

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ControllableDaemonTask(callback);
        if (milliseconds !== SESSION_EVENT_BATCH_WINDOW_MILLISECONDS) {
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
}

async function startControlledDaemon(options: { readonly stateDirectory?: string } = {}): Promise<{
    readonly agent: LocalAgentDefinition;
    readonly close: () => Promise<void>;
    readonly config: ReturnType<typeof createRuntimeConfig>;
    readonly frames: ClientFrames;
    readonly liveBatchSizes: number[];
    readonly socket: Duplex;
    readonly timer: ControllableTimer;
}> {
    const ownsStateDirectory = options.stateDirectory === undefined;
    const stateDirectory = options.stateDirectory ?? (await mkdtemp(join(tmpdir(), "mobius-daemon-timeline-")));
    const workspace = join(stateDirectory, "workspace");
    const nativeStateDirectory = join(stateDirectory, "native");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(nativeStateDirectory, { recursive: true })]);
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
        "controlled-acp",
        "Controlled ACP",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Controlled ACP"],
        { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
    );
    const config = createRuntimeConfig(
        { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const timer = new ControllableTimer();
    const runtime = runRuntime(config, cancellation.signal, timer);
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
            await runtime;
            for (const relaySocket of relaySockets) {
                relaySocket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            if (ownsStateDirectory) {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        },
    };
}

type Fixture = Awaited<ReturnType<typeof startControlledDaemon>>;
const pendingLiveEvents = new WeakMap<Fixture, SessionLiveEvent[]>();
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
async function nextLive(fixture: Fixture): Promise<SessionLiveEvent> {
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
        if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
            continue;
        }
        const events = [...decodeSessionEventEnvelope(frame).events];
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
        encodeSessionHistoryPageLoad({
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
        if (decodeMessageKind(frame) === SESSION_HISTORY_PAGE_LOADED_KIND) {
            return decodeSessionHistoryPageLoaded(frame).events.events;
        }
    }
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
    it("Given a Session emits events before a daemon restart, When Sessions emit after restart, Then event IDs restart per generation and positions stay monotonic per Session", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-event-id-"));
        let firstGenerationId = "";
        let firstPosition = "";
        let lastPosition = 0;
        const first = await startControlledDaemon({ stateDirectory });
        try {
            const command = { ...prompt(first, "first allocation"), commandId: "first-allocation" };
            sendText(first.socket, encodeSessionPromptCommand(command));
            let firstEvent = true;
            for (;;) {
                const event = await nextLive(first);
                expect(Number(event.position)).toBeGreaterThan(lastPosition);
                lastPosition = Number(event.position);
                if (firstEvent) {
                    firstEvent = false;
                    firstGenerationId = event.sessionGenerationId;
                    firstPosition = event.position;
                    expect(event.eventId.endsWith("-0000000000000001")).toBe(true);
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
        } finally {
            await first.close();
        }

        const restarted = await startControlledDaemon({ stateDirectory });
        try {
            const command = { ...prompt(restarted, "second allocation"), commandId: "second-allocation" };
            sendText(restarted.socket, encodeSessionPromptCommand(command));
            let event = await nextLive(restarted);
            expect(event.sessionGenerationId).not.toBe(firstGenerationId);
            expect(event.eventId.startsWith(`event-${event.sessionGenerationId}-`)).toBe(true);
            expect(Number(event.position)).toBeGreaterThan(lastPosition);
            while (event.type !== "lifecycle-metadata" || event.payload.kind !== "prompt.completed") {
                const previousPosition = Number(event.position);
                event = await nextLive(restarted);
                expect(Number(event.position)).toBeGreaterThan(previousPosition);
            }

            const otherSessionCommand = {
                ...prompt(restarted, "separate Session allocation"),
                commandId: "separate-session-allocation",
                sessionId: "other-session",
            };
            sendText(restarted.socket, encodeSessionPromptCommand(otherSessionCommand));
            const otherSessionEvent = await nextLive(restarted);
            expect(otherSessionEvent.eventId.endsWith("-0000000000000001")).toBe(true);
            expect(otherSessionEvent.position).toBe(firstPosition);
        } finally {
            await restarted.close();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given reasoning chunks exceed a 200-event page, When history omits reasoning details, Then 200 events remain and each marker retains its chunk's first identity", async () => {
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
            const firstReasoningEventIds = new Map<string, string>();
            for (const event of complete.events) {
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_thought_chunk" &&
                    typeof event.payload.messageId === "string" &&
                    !firstReasoningEventIds.has(event.payload.messageId)
                ) {
                    firstReasoningEventIds.set(event.payload.messageId, event.eventId);
                }
            }

            const omitted = await history(fixture, command, { eventLimit: 200, omit: ["agent-reasoning"] });
            const retainedReasoning = omitted.events.filter(
                (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
            );

            expect(complete.throughPosition).toBeDefined();
            expect(omitted.throughPosition).toBe(complete.throughPosition);
            expect(omitted.events).toHaveLength(200);
            expect(retainedReasoning.length).toBeGreaterThan(0);
            for (const event of retainedReasoning) {
                if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
                    throw new Error("Expected retained reasoning");
                }
                expect(event.mobiusMetadata).toEqual({ omitted: true });
                expect(event.payload.content).toEqual({ text: "", type: "text" });
                expect(event.eventId).toBe(firstReasoningEventIds.get(event.payload.messageId ?? ""));
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
            const live: SessionEvent[] = [];
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
                    if (accumulated.includes("Controlled ACP turn 1: interleave progress and hold")) {
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
            const liveEventIds = new Set(live.map((event) => event.eventId));
            expect(page.events.every((event) => liveEventIds.has(event.eventId))).toBe(true);
            expect(page.events.length).toBeLessThan(live.length);
            expect(
                page.events.filter(
                    (event) =>
                        event.type === "acp" &&
                        (event.payload.sessionUpdate === "tool_call" ||
                            event.payload.sessionUpdate === "tool_call_update"),
                ),
            ).toHaveLength(1);
            const active = await activeTurn(fixture, command);
            expect(active?.state).toBe("running");
            expect(active?.commandId).toBe(command.commandId);
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
                event.type === "acp" &&
                (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
                    ? [event]
                    : [],
            );
            expect(updates.map((event) => event.payload)).toEqual([
                expect.objectContaining({
                    content: [{ content: { text: "rendered snapshot", type: "text" }, type: "content" }],
                    rawOutput: { output: "final snapshot" },
                    sessionUpdate: "tool_call",
                    status: "completed",
                    toolCallId: "tool-1",
                }),
            ]);
        } finally {
            await fixture.close();
        }
    });
    it("Given token-sized chunks, When the turn completes, Then every token arrives once and live event identities match recovery", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream token burst");
            sendText(fixture.socket, encodeSessionPromptCommand(command));
            const live: SessionLiveEvent[] = [];
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
                `Gathering contextControlled ACP turn 1: ${Array.from({ length: 64 }, (_, index) => `token-${index} `).join("")}`,
            );
            expect(fixture.timer.batchWindowMilliseconds).toContain(100);
            expect(fixture.liveBatchSizes.some((size) => size > 1)).toBe(true);
            const page = await history(fixture, command);
            expect(page.throughPosition).toBe(live.at(-1)?.position);
            const liveEventIds = new Set(live.map((event) => event.eventId));
            expect(page.events.every((event) => liveEventIds.has(event.eventId))).toBe(true);
            expect(page.events.length).toBeLessThan(live.length);
            expect(
                page.events
                    .flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    )
                    .join(""),
            ).toBe(
                `Gathering contextControlled ACP turn 1: ${Array.from({ length: 64 }, (_, index) => `token-${index} `).join("")}`,
            );
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
            let lastPosition = "0";
            while (text.length < 300_000) {
                const event = await nextLive(fixture);
                lastPosition = event.position;
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
            // The running Agent can emit metadata after its last text chunk.
            // The snapshot must cover every observed event, including that text.
            expect(BigInt(page.throughPosition ?? "0")).toBeGreaterThanOrEqual(BigInt(lastPosition));
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
