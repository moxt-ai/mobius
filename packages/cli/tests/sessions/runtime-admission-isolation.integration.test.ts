import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_EVENT_KIND,
    SESSION_OPERATION_FAILED_KIND,
    type SessionLiveEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../src/runtime/config.ts";
import { SESSION_EVENT_BATCH_WINDOW_MILLISECONDS } from "../../src/runtime/relay/session-event-publisher.ts";
import type { ScheduledTask, Timer } from "../../src/runtime/relay/timer.ts";
import { runRuntime } from "../../src/runtime/run.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = new URL("./fixtures/acp-peer.ts", import.meta.url).pathname;
/** The terminal-receipt budget this Runtime admits per pruning scope. */
const MAX_TERMINAL_RECEIPTS = 1_024;

class ControlledTask implements ScheduledTask {
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

class ControlledTimer implements Timer {
    readonly #scheduled: ControlledTask[] = [];
    readonly #waiters: Array<(task: ControlledTask) => void> = [];

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ControlledTask(callback);
        if (milliseconds !== SESSION_EVENT_BATCH_WINDOW_MILLISECONDS) {
            return task;
        }
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#scheduled.push(task);
        } else {
            waiter(task);
        }
        return task;
    };

    readonly nextBatch = (): Promise<ControlledTask> => {
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

interface RuntimeFixture {
    readonly agent: LocalAgentDefinition;
    readonly close: () => Promise<void>;
    readonly config: ReturnType<typeof createRuntimeConfig>;
    readonly frames: ClientFrames;
    readonly socket: Duplex;
    readonly timer: ControlledTimer;
}

async function startControlledRuntime(): Promise<RuntimeFixture> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-admission-"));
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
    const timer = new ControlledTimer();
    const runtime = runRuntime(config, cancellation.signal, timer);
    const socket = await socketReady.promise;
    return {
        agent,
        config,
        frames: new ClientFrames(socket),
        socket,
        timer,
        close: async () => {
            cancellation.abort();
            await runtime;
            for (const relaySocket of relaySockets) {
                relaySocket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        },
    };
}

function promptCommand(
    fixture: RuntimeFixture,
    sessionId: string,
    commandId: string,
    text: string,
    disposition: string = SessionPromptDisposition.Reject,
    targetCommandId = "",
): SessionPromptCommand {
    return {
        additionalDirectoryIds: [],
        agentId: fixture.agent.id,
        bindingId: fixture.config.bindingId,
        commandId,
        directoryId: "default",
        disposition,
        images: [],
        kind: "session.prompt",
        prompt: text,
        resources: [],
        sessionId,
        targetCommandId,
    };
}

/** Streams settlement traffic, running publisher batch tasks as they are scheduled. */
async function* settledFrames(fixture: RuntimeFixture): AsyncGenerator<SettledFrame> {
    const armBatch = (): void => {
        void fixture.timer
            .nextBatch()
            .then((task) => {
                task.run();
                armBatch();
            })
            .catch(() => undefined);
    };
    armBatch();
    for (;;) {
        const frame = await fixture.frames.next();
        const kind = decodeMessageKind(frame);
        if (kind === SESSION_OPERATION_FAILED_KIND) {
            yield { frame, kind: "operation-failed" };
            continue;
        }
        if (kind !== SESSION_EVENT_KIND) {
            continue;
        }
        for (const event of decodeSessionEventEnvelope(frame).events) {
            yield { event, kind: "event" };
        }
    }
}

interface TerminalOutcome {
    readonly code?: string;
    readonly kind: "completed" | "failed";
    readonly stopReason?: string;
}

type SettledFrame =
    | { readonly kind: "event"; readonly event: SessionLiveEvent }
    | { readonly frame: string; readonly kind: "operation-failed" };

type TerminalFrameOutcome = TerminalOutcome & { readonly commandId: string };

function terminalOutcome(settled: SettledFrame): TerminalFrameOutcome | null {
    if (settled.kind === "operation-failed") {
        const failure = JSON.parse(settled.frame) as { readonly code?: string; readonly requestId?: string };
        return failure.requestId === undefined
            ? null
            : {
                  ...(failure.code === undefined ? {} : { code: failure.code }),
                  commandId: failure.requestId,
                  kind: "failed",
              };
    }
    const event = settled.event;
    if (event.type !== "lifecycle-metadata") {
        return null;
    }
    const payload = event.payload;
    if (payload.kind === "prompt.completed") {
        return { commandId: payload.commandId, kind: "completed", stopReason: payload.stopReason };
    }
    if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
        return {
            ...(payload.code === undefined ? {} : { code: payload.code }),
            commandId: payload.commandId,
            kind: "failed",
        };
    }
    return null;
}

async function awaitTerminal(fixture: RuntimeFixture, commandId: string): Promise<TerminalOutcome> {
    for await (const settled of settledFrames(fixture)) {
        const outcome = terminalOutcome(settled);
        if (outcome?.commandId === commandId) {
            return outcome;
        }
    }
    throw new Error("The live event stream ended before the prompt settled");
}

/** Resolves once every given command has reached a terminal settlement. */
async function awaitAllTerminal(
    fixture: RuntimeFixture,
    commandIds: readonly string[],
): Promise<Map<string, TerminalOutcome>> {
    const outcomes = new Map<string, TerminalOutcome>();
    for await (const settled of settledFrames(fixture)) {
        const outcome = terminalOutcome(settled);
        if (outcome !== null && commandIds.includes(outcome.commandId) && !outcomes.has(outcome.commandId)) {
            outcomes.set(outcome.commandId, outcome);
        }
        if (outcomes.size === commandIds.length) {
            return outcomes;
        }
    }
    throw new Error("The live event stream ended before every prompt settled");
}

describe("Runtime admission isolation", () => {
    it("Given another Session consumed the Runtime terminal-receipt budget, When a Session queues behind its own settled target, Then the queue target is still recognized", async () => {
        const fixture = await startControlledRuntime();
        try {
            // Session A completes a target, leaving a terminal receipt behind.
            const target = promptCommand(fixture, "session-a", "session-a-target", "hello");
            sendText(fixture.socket, encodeSessionPromptCommand(target));
            expect((await awaitTerminal(fixture, "session-a-target")).kind).toBe("completed");

            // Session B holds one running turn, so every further prompt in that
            // Session settles immediately as session_busy and leaves a failed
            // receipt. Enough of them exhaust the terminal-receipt budget.
            const holding = promptCommand(fixture, "session-b", "session-b-hold", "interleave progress and hold");
            sendText(fixture.socket, encodeSessionPromptCommand(holding));
            const flood: string[] = [];
            for (let index = 0; index < MAX_TERMINAL_RECEIPTS + 2; index += 1) {
                const commandId = `session-b-flood-${index.toString()}`;
                flood.push(commandId);
                sendText(
                    fixture.socket,
                    encodeSessionPromptCommand(promptCommand(fixture, "session-b", commandId, "busy")),
                );
            }
            const outcomes = await awaitAllTerminal(fixture, flood);
            for (const outcome of outcomes.values()) {
                expect(outcome.kind).toBe("failed");
                expect(outcome.code).toBe("session_busy");
            }

            // The queued prompt must still recognize Session A's settled target.
            const queued = promptCommand(
                fixture,
                "session-a",
                "session-a-queued",
                "queued hello",
                SessionPromptDisposition.Queue,
                "session-a-target",
            );
            sendText(fixture.socket, encodeSessionPromptCommand(queued));
            const queuedOutcome = await awaitTerminal(fixture, "session-a-queued");
            expect(queuedOutcome).toMatchObject({ kind: "completed", stopReason: "end_turn" });
        } finally {
            await fixture.close();
        }
    }, 90_000);
});
