import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentCatalogRefreshedEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionLiveHistoryLoaded,
    encodeAgentCatalogRefreshCommand,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionLiveHistoryLoad,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIVE_HISTORY_LOADED_KIND,
    type SessionConfigurationSelection,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import { LocalAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port, sendText } from "../../../tests/infra/websocket.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

class ClientFrames {
    #buffered = Buffer.alloc(0);
    #eventSequence = 0;
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];
    readonly #socket: Duplex;

    constructor(socket: Duplex) {
        this.#socket = socket;
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
            if (decodeMessageKind(message) === SESSION_EVENT_KIND) {
                const envelope = decodeSessionEventEnvelope(message);
                this.#eventSequence += 1;
                sendText(
                    this.#socket,
                    encodeSessionEventAcknowledgement({
                        cursor: `cursor-${this.#eventSequence.toString()}`,
                        duplicate: false,
                        eventId: envelope.eventId,
                        kind: SESSION_EVENT_ACK_KIND,
                        sequence: this.#eventSequence.toString(),
                        sessionId: envelope.sessionId,
                    }),
                );
            }
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
    readonly text: string;

    constructor(kind: string, text: string, code: string) {
        this.code = code;
        this.kind = kind;
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
        if (commandId.length > 0 && readStringField(payload, "commandId") !== commandId) {
            continue;
        }
        text += readStringField(payload, "text");
        if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
            return new TerminalSessionResult(kind, text, readStringField(payload, "code"));
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
        const payload: unknown = JSON.parse(envelope.payload);
        if (readStringField(payload, "commandId") === commandId) {
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

async function readAgentCatalogRefresh(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== AGENT_CATALOG_REFRESHED_KIND) {
            continue;
        }
        const refreshed = decodeAgentCatalogRefreshedEvent(message);
        if (refreshed.requestId === requestId) {
            return refreshed;
        }
    }
}

async function readSessionLiveHistory(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_LIVE_HISTORY_LOADED_KIND) {
            continue;
        }
        const loaded = decodeSessionLiveHistoryLoaded(message);
        if (loaded.requestId === requestId) {
            return loaded;
        }
    }
}

describe("daemon session configuration boundary", () => {
    it("Given Codex removes a model between capability probes, When settings are discovered, Then the daemon returns supported settings and records the unavailable value", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-changing-model-catalog-"));
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
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
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

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                const event = database
                    .prepare("SELECT details_json FROM audit_events WHERE command_id = ? AND event = ?")
                    .get(requestId, "agent_settings_model_unsupported");
                expect(JSON.parse(readStringField(event, "details_json"))).toEqual({
                    agentId: "codex",
                    code: "invalid_session_configuration",
                    configId: "model",
                    offeredValueCount: "2",
                    offeredValues: '["test-small","test-medium"]',
                    requestedValue: "test-large",
                });
            } finally {
                database.close();
            }
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

    it("Given a cloud-disabled Session uses an application binding, When Mobius reloads its native history, Then the daemon returns the saved conversation", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-live-history-"));
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
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const agent = new LocalAgentDefinition("opencode", "OpenCode", process.execPath, [fakeAgentPath], {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
        });
        const config = createDaemonConfig(
            {
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionId = "cloud_disabled_conversation";
            const applicationBindingId = "binding_application_alpha";
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: applicationBindingId,
                commandId: "save_native_history",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "private conversation",
                resources: [],
                sessionConfigurations: [],
                sessionId,
                targetCommandId: "",
            };
            sendText(socket, encodeSessionPromptCommand(prompt));
            await expect(readTerminalSessionResult(frames, sessionId)).resolves.toMatchObject({
                kind: SESSION_COMPLETED_KIND,
                text: "Echo from ACP: private conversation",
            });

            const requestId = "reload_native_history";
            sendText(
                socket,
                encodeSessionLiveHistoryLoad({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: applicationBindingId,
                    directoryId: "default",
                    kind: "session.live-history.load",
                    requestId,
                    sessionId,
                }),
            );
            await expect(readSessionLiveHistory(frames, requestId)).resolves.toMatchObject({
                history: {
                    messages: expect.arrayContaining([
                        expect.objectContaining({ role: "user", text: "private conversation" }),
                        expect.objectContaining({ role: "assistant", text: "Echo from ACP: private conversation" }),
                    ]),
                    status: "available",
                },
                sessionId,
            });
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

    it("Given a runtime refreshes its shell environment, When its private Agent cache is needed, Then catalog discovery retains the runtime state directory", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-catalog-state-"));
        const discardedStateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-discarded-state-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        const executableDirectory = join(stateDirectory, "external");
        const auditDatabasePath = join(stateDirectory, "audit", "channel_alpha.sqlite");
        const codexPath = join(executableDirectory, "codex");
        const managedAdapterPath = join(
            stateDirectory,
            "adapters",
            "codex",
            "1.8.0",
            "node_modules",
            "@agentclientprotocol",
            "codex-acp",
            "dist",
            "index.js",
        );
        const managedAdapterPackageRoot = dirname(dirname(managedAdapterPath));
        await Promise.all([
            mkdir(workspace, { recursive: true }),
            mkdir(nativeStateDirectory, { recursive: true }),
            mkdir(executableDirectory, { recursive: true }),
            mkdir(dirname(managedAdapterPath), { recursive: true }),
        ]);

        const catalogBodies: string[] = [];
        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                let body = "";
                request.setEncoding("utf8");
                request.on("data", (chunk: string) => {
                    body += chunk;
                });
                request.on("end", () => {
                    catalogBodies.push(body);
                    response.writeHead(204);
                    response.end();
                });
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
            socketReady.resolve(socket);
        });
        await Promise.all([
            writeFile(
                codexPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            ),
            writeFile(
                managedAdapterPath,
                executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env.CODEX_PATH;
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
                { mode: 0o700 },
            ),
            writeFile(
                join(managedAdapterPackageRoot, "package.json"),
                JSON.stringify({
                    bin: { "codex-acp": "dist/index.js" },
                    name: "@agentclientprotocol/codex-acp",
                    version: "1.8.0",
                }),
                { mode: 0o600 },
            ),
        ]);
        await Promise.all([chmod(codexPath, 0o700), chmod(managedAdapterPath, 0o700)]);
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const contextEnvironment = {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            PATH: executableDirectory,
        };
        const config = createDaemonConfig(
            {
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [new LocalAgentDefinition("seed", "Seed", process.execPath, [fakeAgentPath])],
            [],
            new DaemonLocalContext(stateDirectory, contextEnvironment),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
        const daemon = runDaemon(config, audit, cancellation.signal, undefined, {
            resolveAgentCatalogEnvironment: async (signal: AbortSignal): Promise<Readonly<NodeJS.ProcessEnv>> => {
                signal.throwIfAborted();
                return {
                    ...contextEnvironment,
                    MOBIUS_STATE_DIRECTORY: discardedStateDirectory,
                };
            },
        });

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const requestId = "catalog-preserves-runtime-state";
            sendText(
                socket,
                encodeAgentCatalogRefreshCommand({
                    kind: AGENT_CATALOG_REFRESH_KIND,
                    requestId,
                }),
            );
            await readAgentCatalogRefresh(frames, requestId);

            expect(config.catalog.read().agents.map((agent) => agent.id)).toContain("codex");
            expect(catalogBodies.at(-1)).toContain('"id":"codex"');
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            audit.close();
            await daemon;
            await Promise.all([
                rm(stateDirectory, { force: true, recursive: true }),
                rm(discardedStateDirectory, { force: true, recursive: true }),
            ]);
        }
    });

    it("Given an Agent withholds effort for its default model, When settings are discovered without a model, Then the default model's own capability is reported", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-default-effort-"));
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
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
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
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
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

    it("Given a conversation changes its DeepSeek access mode, When the next configured turn runs, Then Mobius resumes the conversation in the selected environment", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-session-configuration-"));
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
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const agent = new LocalAgentDefinition(
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness", "--reasoning-effort-for-test-large-only"],
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createDaemonConfig(
            {
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const discoveryRequestId = "deepseek-settings";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: discoveryRequestId,
                }),
            );
            const discovered = await readAgentSettings(frames, discoveryRequestId);
            expect(discovered.modelEffort).toEqual({
                effortSettingId: "",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: { "test-small": [] },
            });
            expect(discovered.settings).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "dsh_access_mode" }),
                    expect.objectContaining({ id: "model" }),
                ]),
            );
            expect(discovered.settings).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
            const selectedDiscoveryRequestId = "deepseek-large-model-settings";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: agent.id,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    model: "test-large",
                    requestId: selectedDiscoveryRequestId,
                }),
            );
            const selectedModelSettings = await readAgentSettings(frames, selectedDiscoveryRequestId);
            expect(selectedModelSettings.modelEffort).toEqual({
                effortSettingId: "reasoning_effort",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: {
                    "test-large": expect.arrayContaining([expect.objectContaining({ value: "high" })]),
                },
            });
            expect(selectedModelSettings.settings).toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
            const firstSessionConfigurations: readonly SessionConfigurationSelection[] = [
                {
                    booleanValue: false,
                    configId: "dsh_access_mode",
                    value: "read-only",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "model",
                    value: "test-large",
                    valueType: "select",
                },
                {
                    booleanValue: false,
                    configId: "reasoning_effort",
                    value: "high",
                    valueType: "select",
                },
                {
                    booleanValue: true,
                    configId: "fast_mode",
                    value: "",
                    valueType: "boolean",
                },
                {
                    booleanValue: false,
                    configId: "mode",
                    value: "code",
                    valueType: "select",
                },
            ];
            const firstPrompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: "first_configured_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "first configured turn",
                resources: [],
                sessionConfigurations: firstSessionConfigurations,
                sessionId: "configured_conversation",
                targetCommandId: "",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(firstPrompt));
            const firstResult = await readTerminalSessionResult(frames, firstPrompt.sessionId);
            expect(firstResult).toMatchObject({
                kind: SESSION_COMPLETED_KIND,
                text: "DeepSeek Harness turn 1: first configured turn",
            });

            const secondSessionConfigurations: SessionConfigurationSelection[] = [];
            for (const selection of firstSessionConfigurations) {
                if (selection.configId === "reasoning_effort") {
                    continue;
                }
                if (selection.configId === "dsh_access_mode") {
                    secondSessionConfigurations.push({ ...selection, value: "workspace-write" });
                    continue;
                }
                if (selection.configId === "model") {
                    secondSessionConfigurations.push({ ...selection, value: "test-small" });
                    continue;
                }
                secondSessionConfigurations.push(selection);
            }
            const secondPrompt: SessionPromptCommand = {
                ...firstPrompt,
                commandId: "second_configured_turn",
                prompt: "second configured turn",
                sessionConfigurations: secondSessionConfigurations,
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(secondPrompt));
            const secondResult = await readTerminalSessionResult(frames, secondPrompt.sessionId);
            expect(secondResult).toMatchObject({
                kind: SESSION_COMPLETED_KIND,
                text: "DeepSeek Harness turn 2: second configured turn",
            });
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

    it("Given a Turn is running with an Agent settings snapshot, When a steering prompt reuses that snapshot while the live Session exposes fewer settings, Then the Agent receives the steering prompt", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-steer-settings-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        const auditDatabasePath = join(stateDirectory, "audit", "channel_alpha.sqlite");
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
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [agent],
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
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
