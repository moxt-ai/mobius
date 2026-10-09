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
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveHistoryV2PageLoaded,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND,
    type SessionEventV2,
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
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

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

type Fixture = Awaited<ReturnType<typeof startControlledDaemon>>;
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
    for (;;) {
        const frame = await fixture.frames.next();
        expect(decodeMessageKind(frame)).not.toBe("session.event");
        if (decodeMessageKind(frame) === "session.operation.failed") {
            throw new Error(frame);
        }
        if (decodeMessageKind(frame) !== SESSION_EVENT_V2_KIND) {
            continue;
        }
        const event = decodeSessionEventEnvelopeV2(frame).event;
        if (
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
        ) {
            throw new Error(frame);
        }
        return event;
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
async function history(fixture: Fixture, command: SessionPromptCommand) {
    sendText(
        fixture.socket,
        encodeSessionLiveHistoryV2PageLoad({
            kind: "session.live-history.v2.page.load",
            requestId: "history",
            sessionId: command.sessionId,
            agentId: fixture.agent.id,
            bindingId: fixture.config.bindingId,
            directoryId: "default",
            additionalDirectoryIds: [],
            cursor: null,
            eventLimit: 200,
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
            expect(page.events.map(({ eventId, type, payload }) => ({ eventId, type, payload }))).toEqual(
                expect.arrayContaining(live.map(({ eventId, type, payload }) => ({ eventId, type, payload }))),
            );
            const active = await activeTurn(fixture, command);
            expect(active?.messages.some((message) => message.text.includes("OpenCode turn 1:"))).toBe(true);
            await cancel(fixture, command);
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
            const page = await history(fixture, command);
            expect(page.events.map(({ eventId, type, payload }) => ({ eventId, type, payload }))).toEqual(
                live.map(({ eventId, type, payload }) => ({ eventId, type, payload })),
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
