import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentCatalogRefreshedEvent,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionLiveHistoryPageLoaded,
    encodeAgentCatalogRefreshCommand,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionCancelCommand,
    encodeSessionLiveHistoryPageLoad,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOADED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import { AcpSessionManager } from "../../../packages/cli/src/acp/session-manager.ts";
import { AvailableAgent } from "../../../packages/cli/src/agent-catalog/agent-discovery.ts";
import { CodexAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/codex-agent.ts";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import { LocalAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port, sendText } from "../../../tests/infra/websocket.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
const fakeCodexAppServerUrl = new URL("../fixtures/fake-acp-agent/src/app-server.ts", import.meta.url).toString();
const turnAppServerUrl = new URL("../fixtures/fake-acp-agent/src/turn-app-server.ts", import.meta.url).toString();

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

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
        if (commandId.length > 0 && readStringField(payload, "commandId") !== commandId) {
            continue;
        }
        // Only the assistant reply contributes to the turn's text. Activities and
        // narration increments also carry a text-like field for their own decoding.
        if (kind === AGENT_MESSAGE_DELTA_KIND) {
            text += readStringField(payload, "text");
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

async function readSessionLiveHistoryPage(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_LIVE_HISTORY_PAGE_LOADED_KIND) {
            continue;
        }
        const loaded = decodeSessionLiveHistoryPageLoaded(message);
        if (loaded.requestId === requestId) {
            return loaded;
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

    it("Given Codex supports configurable runs, When settings change and its backend fails or is cancelled, Then settings apply and the same Session recovers", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-codex-settings-"));
        const workspace = join(stateDirectory, "workspace");
        const executableDirectory = join(stateDirectory, "external");
        const nativeStateDirectory = join(stateDirectory, "native");
        const codexPath = join(executableDirectory, "codex");
        await Promise.all([
            mkdir(workspace, { recursive: true }),
            mkdir(executableDirectory, { recursive: true }),
            mkdir(nativeStateDirectory),
        ]);
        await writeFile(
            codexPath,
            executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else if (process.argv.includes("app-server")) {
  process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = ${JSON.stringify(nativeStateDirectory)};
  await import(${JSON.stringify(turnAppServerUrl)});
} else {
  process.exit(80);
}
`),
            { mode: 0o700 },
        );
        await chmod(codexPath, 0o700);

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
        // The in-process Agent owns the app-server conversation, so the settings Mobius can offer
        // come from the ACP session it serves. Without them the Run settings panel is empty and a
        // saved model or effort can never be applied.
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment: { MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: executableDirectory },
            signal: new AbortController().signal,
            specifications: [new CodexAgentSpecification()],
        });
        expect(inventory.readyAgents().map((agent) => agent.id)).toEqual(["codex"]);
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            inventory.readyAgents(),
            [],
            new DaemonLocalContext(stateDirectory),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "codex-in-process-settings";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId: "codex",
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);

            const model = discovered.settings.find((setting) => setting.id === "model");
            expect(model?.values.map((value) => value.value)).toEqual(["scripted-small", "scripted-large"]);
            expect(model?.defaultValue).toBe("scripted-small");
            const effort = discovered.settings.find((setting) => setting.id === "reasoning_effort");
            expect(effort?.values.map((value) => value.value)).toEqual(["low", "medium", "high"]);
            expect(effort?.defaultValue).toBe("medium");
            // The default model advertises a speed tier, so fast mode is offered as a toggle.
            expect(discovered.settings.find((setting) => setting.id === "fast-mode")).toMatchObject({
                booleanValue: false,
                type: "boolean",
            });
            expect(discovered.settings.find((setting) => setting.id === "collaboration_mode")).toMatchObject({
                defaultValue: "default",
                type: "select",
                values: [{ value: "default" }, { value: "plan" }],
            });
            expect(discovered.settings.find((setting) => setting.id === "mode")).toMatchObject({
                defaultValue: "agent",
                type: "select",
                values: [{ value: "read-only" }, { value: "agent" }, { value: "agent-full-access" }],
            });
            expect(discovered.modelEffort).toMatchObject({
                effortSettingId: "reasoning_effort",
                modelSettingId: "model",
                resolution: "complete",
                valuesByModel: {
                    "scripted-large": [expect.objectContaining({ value: "high" })],
                    "scripted-small": [
                        expect.objectContaining({ value: "low" }),
                        expect.objectContaining({ value: "medium" }),
                        expect.objectContaining({ value: "high" }),
                    ],
                },
            });

            // Until a mode is chosen, the host's own approval and sandbox policy must win. Sending
            // Mobius defaults unconditionally would override `config.toml`, which is how a host that
            // cannot build the sandbox ends up running every tool call inside a failing one.
            const inheritedPrompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId: "inherited_codex_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "inherited turn",
                resources: [],
                sessionId: "inherited_codex_conversation",
                targetCommandId: "",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(inheritedPrompt));
            const inherited = await readTerminalSessionResult(frames, inheritedPrompt.sessionId);
            expect(inherited.text).toBe("Scripted Codex answer (scripted-small/medium/undefined/undefined/default)");

            // Discovery alone is not the fix: a selection has to reach Codex. The app-server names
            // the model and effort each turn ran with, so the answer proves the choice was applied.
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId: "configured_codex_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "configured turn",
                resources: [],
                sessionConfigurations: [
                    {
                        booleanValue: false,
                        configId: "model",
                        value: "scripted-large",
                        valueType: "select",
                    },
                    // Full access carries `never`, which distinguishes the applied preset from the
                    // default mode's `on-request`.
                    {
                        booleanValue: false,
                        configId: "mode",
                        value: "agent-full-access",
                        valueType: "select",
                    },
                    {
                        booleanValue: false,
                        configId: "collaboration_mode",
                        value: "plan",
                        valueType: "select",
                    },
                ],
                sessionId: "configured_codex_conversation",
                targetCommandId: "",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(prompt));
            const result = await readTerminalSessionResult(frames, prompt.sessionId);
            expect(result).toMatchObject({ kind: SESSION_COMPLETED_KIND });
            // Switching to a model that only supports "high" re-resolves the effort, which is what
            // Codex does and what the reply's own settings then advertise. Full access sends `never`
            // rather than the default mode's `on-request`, so the mode reached Codex too.
            expect(result.text).toBe("Scripted Codex answer (scripted-large/high/never/undefined/plan)");

            // Fast mode is offered per model. Turning it on for a model with a speed tier sends the
            // resolved tier, and switching to a model without one drops it rather than sending a
            // tier that model cannot run.
            const fastPrompt: SessionPromptCommand = {
                ...prompt,
                commandId: "fast_codex_turn",
                prompt: "fast turn",
                sessionConfigurations: [
                    {
                        booleanValue: true,
                        configId: "fast-mode",
                        value: "",
                        valueType: "boolean",
                    },
                    {
                        booleanValue: false,
                        configId: "model",
                        value: "scripted-small",
                        valueType: "select",
                    },
                ],
                sessionId: "fast_codex_conversation",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(fastPrompt));
            const fastResult = await readTerminalSessionResult(frames, fastPrompt.sessionId);
            // No mode was selected in this session, so it inherits the host's own policy: the turn
            // omits approval and sandbox rather than overriding what the host configured.
            expect(fastResult.text).toBe("Scripted Codex answer (scripted-small/medium/undefined/priority/default)");

            for (const fault of [
                {
                    name: "exit-after-ack",
                    prompt: "fixture: exit after turn acknowledgement",
                    code: "codex_app_server_exited",
                },
                {
                    name: "exit-before-ack",
                    prompt: "fixture: exit before turn acknowledgement",
                    code: "codex_app_server_exited",
                },
                {
                    name: "invalid-frame",
                    prompt: "fixture: invalid frame after turn acknowledgement",
                    code: "codex_app_server_protocol_error",
                },
            ]) {
                const interruptedPrompt: SessionPromptCommand = {
                    ...inheritedPrompt,
                    commandId: `codex-${fault.name}`,
                    prompt: fault.prompt,
                };
                sendText(await socketReady.promise, encodeSessionPromptCommand(interruptedPrompt));
                const failure = await readTerminalSessionResult(
                    frames,
                    interruptedPrompt.sessionId,
                    interruptedPrompt.commandId,
                );
                expect(failure).toMatchObject({ kind: SESSION_FAILED_KIND, code: fault.code });
                const recoveredPrompt: SessionPromptCommand = {
                    ...inheritedPrompt,
                    commandId: `codex-recovered-${fault.name}`,
                    prompt: "continue the same conversation",
                };
                sendText(await socketReady.promise, encodeSessionPromptCommand(recoveredPrompt));
                const recovered = await readTerminalSessionResult(
                    frames,
                    recoveredPrompt.sessionId,
                    recoveredPrompt.commandId,
                );
                expect(recovered.kind).toBe(SESSION_COMPLETED_KIND);
                expect(recovered.text).toContain("Scripted Codex answer");
            }

            const heldPrompt: SessionPromptCommand = {
                ...inheritedPrompt,
                commandId: "codex-cancel-running-turn",
                prompt: "fixture: wait for cancellation",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(heldPrompt));
            await readCommandActivity(frames, heldPrompt.sessionId, heldPrompt.commandId);
            sendText(
                await socketReady.promise,
                encodeSessionCancelCommand({
                    kind: SESSION_CANCEL_KIND,
                    sessionId: heldPrompt.sessionId,
                    commandId: heldPrompt.commandId,
                }),
            );
            expect(await readTerminalSessionResult(frames, heldPrompt.sessionId, heldPrompt.commandId)).toMatchObject({
                kind: SESSION_COMPLETED_KIND,
                stopReason: "cancelled",
            });
            const afterCancellation: SessionPromptCommand = {
                ...inheritedPrompt,
                commandId: "codex-after-cancellation",
                prompt: "continue after cancellation",
            };
            sendText(await socketReady.promise, encodeSessionPromptCommand(afterCancellation));
            const resumed = await readTerminalSessionResult(
                frames,
                afterCancellation.sessionId,
                afterCancellation.commandId,
            );
            expect(resumed.kind).toBe(SESSION_COMPLETED_KIND);
            expect(resumed.text).toContain("Scripted Codex answer");
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

    it("Given Codex runs as an in-process Agent, When Mobius lists, resumes, and steers native sessions, Then each reaches the Codex app-server", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-codex-native-sessions-"));
        const executableDirectory = join(temporaryDirectory, "external");
        const nativeStateDirectory = join(temporaryDirectory, "native");
        const codexPath = join(executableDirectory, "codex");
        await Promise.all([
            mkdir(executableDirectory, { mode: 0o700, recursive: true }),
            mkdir(nativeStateDirectory, { recursive: true }),
        ]);
        await writeFile(
            codexPath,
            executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else if (process.argv.includes("app-server")) {
  await import(${JSON.stringify(turnAppServerUrl)});
} else {
  process.exit(80);
}
`),
            { mode: 0o700 },
        );
        await chmod(codexPath, 0o700);

        // The in-process Agent and every app-server it starts inherit their environment from this
        // process, and discovery does not forward this fixture variable, so it is set here for the
        // duration of the test.
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = nativeStateDirectory;
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: temporaryDirectory,
            environment: { MOBIUS_STATE_DIRECTORY: temporaryDirectory, PATH: executableDirectory },
            signal: new AbortController().signal,
            specifications: [new CodexAgentSpecification()],
        });
        const discovered = inventory.available[0];
        if (!(discovered instanceof AvailableAgent)) {
            throw new Error("Codex was not discovered");
        }
        const manager = new AcpSessionManager();
        try {
            const run = async (sessionId: string, prompt: string): Promise<void> => {
                await manager.runPrompt({
                    additionalDirectories: [],
                    agent: discovered.agent,
                    commandId: `${sessionId}-${prompt}`,
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: () => Promise.resolve(),
                    prompt,
                    resources: [],
                    sessionId,
                    signal: new AbortController().signal,
                });
            };

            const browseOptions = {
                additionalDirectories: [],
                agent: discovered.agent,
                cwd: temporaryDirectory,
                sessionId: "native_session_browser",
                signal: new AbortController().signal,
            };

            // A conversation becomes a native thread the app-server knows about.
            await run("native_session_conversation", "first");
            const listed = await manager.listNativeSessions(browseOptions, null);
            expect(listed.sessions).toHaveLength(1);
            const nativeSessionId = listed.sessions[0]?.sessionId ?? "";
            expect(nativeSessionId).toMatch(/^thread-/u);
            // The fixture reports a preview and unix-second timestamps; Mobius needs an ISO instant.
            expect(listed.sessions[0]).toMatchObject({
                cwd: temporaryDirectory,
                title: "Scripted turn",
            });
            expect(listed.sessions[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        } finally {
            await manager.close();
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a Codex Session uses the Runtime binding, When Mobius reloads native history, Then the daemon reads rich history without acquiring another writer", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-live-history-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);
        const executable = join(stateDirectory, "codex.mjs");
        await writeFile(
            executable,
            `#!${process.execPath}\nawait import(process.argv.includes("app-server") ? ${JSON.stringify(fakeCodexAppServerUrl)} : ${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});\n`,
            { mode: 0o700 },
        );

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
        const agent = new LocalAgentDefinition("codex", "Codex", executable, ["--exclusive-writer"], {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
        });
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
            const sessionId = "native_history_conversation";
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
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
                encodeSessionLiveHistoryPageLoad({
                    additionalDirectoryIds: [],
                    agentId: agent.id,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    cursor: null,
                    kind: "session.live-history.page.load",
                    limit: 1,
                    requestId,
                    sessionId,
                }),
            );
            await expect(readSessionLiveHistoryPage(frames, requestId)).resolves.toMatchObject({
                page: {
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            activities: expect.arrayContaining([
                                expect.objectContaining({
                                    activityType: "reasoning",
                                    output: "Inspecting the workspace",
                                }),
                                expect.objectContaining({ activityType: "tool", title: "cat package.json" }),
                                expect.objectContaining({
                                    activityType: "tool",
                                    output: "Agent could not inspect the optional workspace file",
                                    status: "failed",
                                    title: "Agent error",
                                }),
                            ]),
                            role: "assistant",
                            text: "Echo from ACP: private conversation",
                        }),
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
        const codexPath = join(executableDirectory, "codex");
        await Promise.all([
            mkdir(workspace, { recursive: true }),
            mkdir(nativeStateDirectory, { recursive: true }),
            mkdir(executableDirectory, { recursive: true }),
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
        await writeFile(
            codexPath,
            executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else if (process.argv.includes("app-server")) {
  await import(${JSON.stringify(turnAppServerUrl)});
} else {
  process.exit(80);
}
`),
            { mode: 0o700 },
        );
        await chmod(codexPath, 0o700);
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const contextEnvironment = {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            PATH: executableDirectory,
        };
        const config = createDaemonConfig(
            {
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            [new LocalAgentDefinition("seed", "Seed", process.execPath, [fakeAgentPath])],
            [],
            new DaemonLocalContext(stateDirectory, contextEnvironment),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore();
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
