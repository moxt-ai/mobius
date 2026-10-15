import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionEventEnvelopeV2,
    decodeSessionOperationFailedEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_V2_KIND,
    SESSION_FAILED_KIND,
    type SessionEventV2,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
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
            this.decode();
        });
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
    };

    private readonly decode = (): void => {
        while (this.#buffered.byteLength >= 6) {
            const encodedLength = this.#buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                throw new Error("Test relay received an oversized daemon frame");
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (this.#buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? this.#buffered.readUInt16BE(2) : encodedLength;
            const frameLength = headerLength + 4 + payloadLength;
            if (this.#buffered.byteLength < frameLength) {
                return;
            }
            const opcode = this.#buffered.readUInt8(0) & 0x0f;
            const mask = this.#buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(this.#buffered.subarray(headerLength + 4, frameLength));
            this.#buffered = this.#buffered.subarray(frameLength);
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            if (opcode !== 1) {
                continue;
            }
            const message = payload.toString("utf8");
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(message);
            } else {
                resolve(message);
            }
        }
    };
}

class TerminalSessionResult {
    readonly code: string;
    readonly kind: string;
    readonly stopReason: string;
    readonly text: string;

    constructor(kind: string, text: string, code: string, stopReason: string) {
        this.code = code;
        this.kind = kind;
        this.stopReason = stopReason;
        this.text = text;
    }
}

const bufferedSessionEvents = new WeakMap<ClientFrames, SessionEventV2[]>();

function _readStringField(value: unknown, field: string): string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "";
    }
    const fieldValue = Reflect.get(value, field);
    return typeof fieldValue === "string" ? fieldValue : "";
}

async function readTerminalSessionResult(
    frames: ClientFrames,
    sessionId: string,
    commandId = "",
    includeAcpText = true,
): Promise<TerminalSessionResult> {
    let text = "";
    const deferredEvents: SessionEventV2[] = [];
    for (;;) {
        let events = bufferedSessionEvents.get(frames) ?? [];
        bufferedSessionEvents.delete(frames);
        if (events.length === 0) {
            const message = await frames.next();
            if (decodeMessageKind(message) === "session.operation.failed") {
                const failure = decodeSessionOperationFailedEvent(message);
                if (failure.sessionId === sessionId && (commandId === "" || failure.requestId === commandId)) {
                    return new TerminalSessionResult(SESSION_FAILED_KIND, text, failure.code, "");
                }
            }
            if (decodeMessageKind(message) !== SESSION_EVENT_V2_KIND) {
                continue;
            }
            events = [...decodeSessionEventEnvelopeV2(message).events];
        }
        for (const [index, event] of events.entries()) {
            if (event.sessionId !== sessionId) {
                continue;
            }
            if (event.type === "acp") {
                if (event.payload.sessionUpdate === "agent_message_chunk" && event.payload.content.type === "text") {
                    if (includeAcpText) {
                        text += event.payload.content.text;
                    } else {
                        deferredEvents.push(event);
                    }
                }
                continue;
            }
            const payload = event.payload;
            if (!("commandId" in payload) || (commandId !== "" && payload.commandId !== commandId)) {
                continue;
            }
            if (payload.kind === "prompt.completed") {
                bufferedSessionEvents.set(frames, [...deferredEvents, ...events.slice(index + 1)]);
                return new TerminalSessionResult(SESSION_COMPLETED_KIND, text, "", payload.stopReason);
            }
            if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
                bufferedSessionEvents.set(frames, [...deferredEvents, ...events.slice(index + 1)]);
                return new TerminalSessionResult(SESSION_FAILED_KIND, text, payload.code, "");
            }
        }
    }
}
async function readCommandActivity(frames: ClientFrames, sessionId: string, _commandId: string): Promise<void> {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_EVENT_V2_KIND) {
            continue;
        }
        if (
            decodeSessionEventEnvelopeV2(message).events.some(
                (event) =>
                    event.sessionId === sessionId &&
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update"),
            )
        ) {
            return;
        }
    }
}

async function readAgentSettings(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== AGENT_SETTINGS_DISCOVERED_KIND) {
            continue;
        }
        const discovered = decodeAgentSettingsDiscoveredEvent(message);
        if (discovered.requestId === requestId) {
            return discovered;
        }
    }
}

describe("daemon session configuration boundary", () => {
    it("Given Codex removes a model between capability probes, When settings are discovered, Then the daemon returns supported settings and records the unavailable value", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-changing-model-catalog-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
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
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
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
            "codex",
            "Codex",
            process.execPath,
            [fakeAgentPath, "--change-model-catalog-after-first-process"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const daemon = runDaemon(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "codex-changing-model-catalog";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);
            expect(discovered.modelEffort).toMatchObject({
                resolution: "complete",
                unsupportedModelIds: ["test-large"],
                valuesByModel: { "test-small": expect.any(Array) },
            });
            const model = discovered.settings.find((setting) => setting.id === "model");
            expect(model?.values.map((value) => value.value)).toEqual(["test-small"]);
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await daemon;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent withholds effort for its default model, When settings are discovered without a model, Then the default model's own capability is reported", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-default-effort-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
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
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
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
        // The Agent withholds reasoning effort for its default model, so a
        // session that never switches models must still learn that model's
        // capability instead of offering no effort control at all.
        const agent = new LocalAgentDefinition(
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Controlled ACP", "--without-reasoning-effort"],
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const daemon = runDaemon(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const noEffortRequestId = "controlled-settings-without-effort";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: noEffortRequestId,
                }),
            );
            const withoutEffort = await readAgentSettings(frames, noEffortRequestId);
            expect(withoutEffort.modelEffort).toEqual({
                effortSettingId: "",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: { "test-small": [] },
            });
            expect(withoutEffort.settings).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await daemon;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent offers effort for its default model, When settings are discovered without a model, Then the session can adjust effort without switching models", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-default-effort-offered-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
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
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
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
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const daemon = runDaemon(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "controlled-default-model-effort";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);
            expect(discovered.settings).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: "reasoning_effort",
                        values: expect.arrayContaining([expect.objectContaining({ value: "medium" })]),
                    }),
                ]),
            );
            expect(discovered.modelEffort).toEqual({
                effortSettingId: "reasoning_effort",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: {
                    "test-small": expect.arrayContaining([expect.objectContaining({ value: "medium" })]),
                },
            });
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await daemon;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a Turn is running with an Agent settings snapshot, When a steering prompt reuses that snapshot while the live Session exposes fewer settings, Then the Agent receives the steering prompt", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-steer-settings-"));
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
        // The Agent reveals reasoning effort only for test-large, so the settings
        // snapshot that names it cannot match a Session parked on test-small.
        const agent = new LocalAgentDefinition(
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Controlled ACP", "--reasoning-effort-for-test-large-only"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const daemon = runDaemon(config, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionId = "steered_configured_conversation";
            const runningCommandId = "running_configured_turn";
            const runningPrompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: runningCommandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "wait for steering",
                resources: [],
                sessionConfigurations: [
                    { booleanValue: false, configId: "removed_access_mode", value: "read-only", valueType: "select" },
                    { booleanValue: false, configId: "model", value: "test-small", valueType: "select" },
                    { booleanValue: false, configId: "reasoning_effort", value: "high", valueType: "select" },
                    { booleanValue: true, configId: "fast_mode", value: "", valueType: "boolean" },
                    { booleanValue: false, configId: "mode", value: "code", valueType: "select" },
                ],
                sessionId,
                targetCommandId: "",
            };
            sendText(socket, encodeSessionPromptCommand(runningPrompt));
            await readCommandActivity(frames, sessionId, runningCommandId);

            const steeringPrompt: SessionPromptCommand = {
                ...runningPrompt,
                commandId: "steering_configured_turn",
                disposition: SessionPromptDisposition.Steer,
                prompt: "focus on the requested fix",
                targetCommandId: runningCommandId,
            };
            sendText(socket, encodeSessionPromptCommand(steeringPrompt));

            // The steering Turn is accepted and then injected into the running
            // Turn, so only the running Turn carries the Agent's reply.
            const steeringResult = await readTerminalSessionResult(frames, sessionId, steeringPrompt.commandId, false);
            expect(steeringResult).toMatchObject({ kind: SESSION_COMPLETED_KIND, text: "" });
            const runningResult = await readTerminalSessionResult(frames, sessionId, runningCommandId);
            expect(runningResult.kind).toBe(SESSION_COMPLETED_KIND);
            expect(runningResult.text).toContain("Steered: focus on the requested fix");
        } finally {
            cancellation.abort();
            await daemon;
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
