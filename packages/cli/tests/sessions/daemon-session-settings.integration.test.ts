import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
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

function readStringField(value: unknown, field: string): string {
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
): Promise<TerminalSessionResult> {
    let text = "";
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
            continue;
        }
        const envelope = decodeSessionEventEnvelope(message);
        if (envelope.sessionId !== sessionId) {
            continue;
        }
        const kind = decodeMessageKind(envelope.payload);
        const payload: unknown = JSON.parse(envelope.payload);
        if (kind === AGENT_MESSAGE_DELTA_KIND) {
            const delta = decodeAgentMessageDeltaEvent(envelope.payload);
            if (commandId.length === 0 || delta.commandId === commandId) {
                text += delta.text;
            }
            continue;
        }
        if (commandId.length > 0 && readStringField(payload, "commandId") !== commandId) {
            continue;
        }
        if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
            return new TerminalSessionResult(
                kind,
                text,
                readStringField(payload, "code"),
                readStringField(payload, "stopReason"),
            );
        }
    }
}

async function readCommandActivity(frames: ClientFrames, sessionId: string, commandId: string): Promise<void> {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
            continue;
        }
        const envelope = decodeSessionEventEnvelope(message);
        if (envelope.sessionId !== sessionId || decodeMessageKind(envelope.payload) !== AGENT_ACTIVITY_KIND) {
            continue;
        }
        const activity = decodeAgentActivityEvent(envelope.payload);
        if (activity.commandId === commandId) {
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
    it("Given OpenCode's ACP catalog omits a locally configured model, When Agent settings are discovered, Then the CLI model is available", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-opencode-provider-settlement-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        const auditDatabasePath = join(stateDirectory, "audit", "channel_alpha.sqlite");
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
            "opencode",
            "OpenCode",
            process.execPath,
            [fakeAgentPath, "acp", "--acp-omits-custom-model"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "opencode-custom-provider-settings";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);
            const model = discovered.settings.find((setting) => setting.id === "model");
            expect(model?.values).toEqual(
                expect.arrayContaining([expect.objectContaining({ value: "custom-provider/custom-model" })]),
            );
            await expect(stat(auditDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            audit.close();
            await daemon;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

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
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

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
            audit.close();
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
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness", "--without-reasoning-effort"],
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
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const noEffortRequestId = "deepseek-settings-without-effort";
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
            audit.close();
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
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness"],
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
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "deepseek-default-model-effort";
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
            audit.close();
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
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness", "--reasoning-effort-for-test-large-only"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

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
                    { booleanValue: false, configId: "dsh_access_mode", value: "read-only", valueType: "select" },
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
            const steeringResult = await readTerminalSessionResult(frames, sessionId, steeringPrompt.commandId);
            expect(steeringResult).toMatchObject({ kind: SESSION_COMPLETED_KIND, text: "" });
            const runningResult = await readTerminalSessionResult(frames, sessionId, runningCommandId);
            expect(runningResult.kind).toBe(SESSION_COMPLETED_KIND);
            expect(runningResult.text).toContain("Steered: focus on the requested fix");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
