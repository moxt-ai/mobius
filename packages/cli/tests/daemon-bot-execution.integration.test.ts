import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    type AgentExecutionConfiguration,
    BotSessionPromptCommand,
    decodeMessageKind,
    decodeRuntimeDeliveryReceived,
    decodeSessionEventEnvelope,
    decodeSessionFailedEvent,
    decodeSessionOperationFailedEvent,
    encodeBotSessionPromptCommand,
    encodeRuntimeDelivery,
    encodeRuntimeDeliveryCommitted,
    encodeSessionEventAcknowledgement,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    OwnerBotReplyRoute,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_STARTED_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverLocalAgentInventory } from "../src/agent-catalog/discover-local-agents.ts";
import { AuditStore } from "../src/audit/audit-store.ts";
import { createDaemonConfig } from "../src/config.ts";
import { runDaemon } from "../src/run-daemon.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

function readPort(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Test Relay did not bind to a TCP port");
    }
    return address.port;
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
                throw new Error("Test Relay received an oversized daemon frame");
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
                writeServerTextFrame(
                    this.#socket,
                    encodeSessionEventAcknowledgement({
                        cursor: `bot-cursor-${this.#eventSequence.toString()}`,
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

function writeServerTextFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, "utf8");
    const header =
        payload.byteLength < 126
            ? Buffer.from([0x81, payload.byteLength])
            : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
    socket.write(Buffer.concat([header, payload]));
}

function restore(name: string, value: NodeJS.ProcessEnv[string]): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

async function readCompletedText(frames: ClientFrames): Promise<string> {
    let observedText = "";
    let completed = false;
    while (!completed) {
        const envelope = decodeSessionEventEnvelope(await frames.next());
        const kind = decodeMessageKind(envelope.payload);
        completed = kind === SESSION_COMPLETED_KIND;
        const payload: unknown = JSON.parse(envelope.payload);
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
            const text = Reflect.get(payload, "text");
            if (typeof text === "string") {
                observedText += text;
            }
        }
    }
    return observedText;
}

async function deliverBotCommand(
    socket: Duplex,
    frames: ClientFrames,
    deliveryId: string,
    command: BotSessionPromptCommand,
): Promise<void> {
    writeServerTextFrame(
        socket,
        encodeRuntimeDelivery({
            deliveryId,
            kind: RUNTIME_DELIVERY_KIND,
            payload: encodeBotSessionPromptCommand(command),
            sessionId: command.sessionId,
        }),
    );
    let received = false;
    while (!received) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== RUNTIME_DELIVERY_RECEIVED_KIND) {
            continue;
        }
        received = decodeRuntimeDeliveryReceived(message).deliveryId === deliveryId;
    }
    writeServerTextFrame(
        socket,
        encodeRuntimeDeliveryCommitted({
            deliveryId,
            kind: RUNTIME_DELIVERY_COMMITTED_KIND,
            sessionId: command.sessionId,
        }),
    );
}

describe("daemon Bot execution boundary", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    });
    afterEach(() => vi.useRealTimers());
    it("Given a paired Runtime root, When Bot commands select directories inside it, Then the daemon validates and executes them", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-bot-long-state-directory-"));
        const workspace = join(stateDirectory, "workspace");
        const overrideWorkspace = join(stateDirectory, "override-workspace");
        const native = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(overrideWorkspace), mkdir(native)]);
        const auditDatabasePath = join(stateDirectory, "audit", "channel_alpha.sqlite");
        const bin = join(stateDirectory, "bin");
        await mkdir(bin);
        // Stateful ACP processes stand in for a provider requiring interactive authentication.
        await writeFile(
            join(bin, "codex"),
            `#!${process.execPath}\nif (process.argv.includes("--version")) process.stdout.write("codex 0.153.0\\n");\n`,
            { mode: 0o700 },
        );
        await writeFile(
            join(bin, "codex-acp"),
            `#!${process.execPath}\nif (process.argv.includes("--version")) { process.stdout.write("codex-acp 1.8.0\\n"); } else { process.argv.push("--agent-name", "Codex", "--announce-config-while-creating"); await import(${JSON.stringify(fakeAgentPath)}); }\n`,
            { mode: 0o700 },
        );
        const environment = {
            ...process.env,
            PATH: bin,
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: native,
        };
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment,
            signal: AbortSignal.timeout(20_000),
        });
        expect(inventory.available.map((entry) => entry.agent.id)).toContain("codex");
        const daemonToken = "d".repeat(43);
        const socketReady = Promise.withResolvers<Duplex>();
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
        const sockets = new Set<Duplex>();
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
            socketReady.resolve(socket);
        });
        await listen(relay);

        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousNativeDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = native;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        const relayUrl = new URL(`ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", daemonToken);
        await mkdir(join(stateDirectory, "connections"));
        await writeFile(
            join(stateDirectory, "connections", "channel_alpha.json"),
            JSON.stringify({
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayOrigin: `http://127.0.0.1:${readPort(relay)}`,
                runtimeCredential: daemonToken,
            }),
            { mode: 0o600 },
        );
        const config = createDaemonConfig(
            {
                auditDatabasePath,
                channelId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            inventory.available.map((entry) => entry.agent),
        );
        const cancellation = new AbortController();
        const audit = new AuditStore(auditDatabasePath);
        const daemon = runDaemon(config, audit, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const selectedExecutionConfiguration: AgentExecutionConfiguration = {
                model: {
                    booleanValue: false,
                    configId: "model",
                    value: "test-large",
                    valueType: "select",
                },
                permissionMode: "agent_default",
                reasoningEffort: {
                    booleanValue: false,
                    configId: "reasoning_effort",
                    value: "high",
                    valueType: "select",
                },
            };
            const directPrompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId: "command_direct_configuration",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "Report execution settings",
                resources: [],
                sessionConfigurations: [
                    {
                        booleanValue: false,
                        configId: "permission_mode",
                        value: "agent_default",
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
                ],
                sessionId: "session_direct_configuration",
                targetCommandId: "",
            };
            writeServerTextFrame(socket, encodeSessionPromptCommand(directPrompt));
            expect(await readCompletedText(frames)).toContain("code test-large high fast");

            const incompletePrompt: SessionPromptCommand = {
                ...directPrompt,
                commandId: "command_incomplete_configuration",
                sessionConfigurations:
                    directPrompt.sessionConfigurations === undefined
                        ? []
                        : directPrompt.sessionConfigurations.slice(0, 1),
                sessionId: "session_incomplete_configuration",
            };
            writeServerTextFrame(socket, encodeSessionPromptCommand(incompletePrompt));
            let receivedIncompleteFailure = false;
            const incompleteKinds: string[] = [];
            while (!receivedIncompleteFailure) {
                const failedEnvelope = decodeSessionEventEnvelope(await frames.next());
                const failedKind = decodeMessageKind(failedEnvelope.payload);
                incompleteKinds.push(failedKind);
                if (failedKind !== SESSION_FAILED_KIND) {
                    continue;
                }
                expect(decodeSessionFailedEvent(failedEnvelope.payload)).toMatchObject({
                    code: "invalid_session_configuration",
                    commandId: incompletePrompt.commandId,
                });
                receivedIncompleteFailure = true;
            }
            expect(incompleteKinds).not.toContain(SESSION_STARTED_KIND);
            const binding = {
                behaviorDigest: "a".repeat(64),
                behaviorInstructions: "Follow the Bot behavior.",
                behaviorRevisionId: "behavior_alpha",
                bindingId: "binding_alpha",
                bindingRevision: 1,
                botId: "bot_alpha",
            };

            const overrideDirectoryId = `path-${Buffer.from(overrideWorkspace, "utf8").toString("base64url")}`;
            const unpreparedOverride = new BotSessionPromptCommand(
                "session_override",
                "message_unprepared_override",
                "codex",
                binding.bindingId,
                overrideDirectoryId,
                [],
                [],
                [],
                "Report Bot execution settings",
                "execution_unprepared_override",
                "capability_unprepared_override",
                "b".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_override",
                "turn_unprepared_override",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(unpreparedOverride));
            expect(await readCompletedText(frames)).toBe(
                `test-large|${await realpath(overrideWorkspace)}|bot-context|relay-cleared`,
            );

            writeServerTextFrame(
                socket,
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: [],
                    agentId: "missing-agent",
                    bindingId: config.bindingId,
                    directoryId: overrideDirectoryId,
                    kind: SESSION_PREPARE_KIND,
                    requestId: "prepare_missing_agent",
                    sessionId: "session_missing_agent",
                }),
            );
            expect(decodeSessionOperationFailedEvent(await frames.next())).toMatchObject({
                requestId: "prepare_missing_agent",
                runtimeTimings: expect.arrayContaining([
                    expect.objectContaining({ name: "workspace-resolve" }),
                    expect.objectContaining({ name: "prepare-total" }),
                ]),
                sessionId: "session_missing_agent",
            });

            const configuredBotPrompt = new BotSessionPromptCommand(
                "session_bot_configuration",
                "message_bot_configuration",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "Report Bot execution settings",
                "execution_bot_configuration",
                "capability_bot_configuration",
                "d".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_alpha",
                "turn_bot_configuration",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(configuredBotPrompt));
            expect(await readCompletedText(frames)).toBe(
                `test-large|${await realpath(workspace)}|bot-context|relay-cleared`,
            );

            const prompt = new BotSessionPromptCommand(
                "session_alpha",
                "message_alpha",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "Report prompt blocks",
                "execution_alpha",
                "capability_alpha",
                "c".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_alpha",
                "turn_alpha",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            const deliveryId = "delivery_bot_prompt_alpha";
            writeServerTextFrame(
                socket,
                encodeRuntimeDelivery({
                    deliveryId,
                    kind: RUNTIME_DELIVERY_KIND,
                    payload: encodeBotSessionPromptCommand(prompt),
                    sessionId: prompt.sessionId,
                }),
            );
            expect(decodeRuntimeDeliveryReceived(await frames.next())).toEqual({
                deliveryId,
                kind: RUNTIME_DELIVERY_RECEIVED_KIND,
                sessionId: prompt.sessionId,
            });
            writeServerTextFrame(
                socket,
                encodeRuntimeDeliveryCommitted({
                    deliveryId,
                    kind: RUNTIME_DELIVERY_COMMITTED_KIND,
                    sessionId: prompt.sessionId,
                }),
            );

            const observedKinds: string[] = [];
            const observedSourceKinds: string[] = [];
            let observedText = "";
            while (!observedKinds.includes(SESSION_COMPLETED_KIND)) {
                const envelope = decodeSessionEventEnvelope(await frames.next());
                const kind = decodeMessageKind(envelope.payload);
                observedKinds.push(kind);
                observedSourceKinds.push(envelope.source.kind);
                const payload: unknown = JSON.parse(envelope.payload);
                if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
                    const text = Reflect.get(payload, "text");
                    if (typeof text === "string") {
                        observedText += text;
                    }
                }
            }
            expect(observedKinds.slice(0, 2)).toEqual([SESSION_CONFIG_UPDATED_KIND, SESSION_STARTED_KIND]);
            expect(observedSourceKinds.slice(0, 2)).toEqual(["runtime", "attempt"]);
            expect(observedText).toBe("0 image, 1 resource");

            const activeBotPrompt = new BotSessionPromptCommand(
                "session_bot_steering",
                "message_bot_active",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "wait for steering",
                "execution_bot_active",
                "capability_bot_active",
                "g".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_bot_steering",
                "turn_bot_active",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            await deliverBotCommand(socket, frames, "delivery_bot_active", activeBotPrompt);
            let activeBotIsRunning = false;
            while (!activeBotIsRunning) {
                const envelope = decodeSessionEventEnvelope(await frames.next());
                activeBotIsRunning = decodeMessageKind(envelope.payload) === AGENT_ACTIVITY_KIND;
            }

            const steeringBotPrompt = new BotSessionPromptCommand(
                activeBotPrompt.sessionId,
                "message_bot_steering",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "focus on verified behavior",
                "execution_bot_steering",
                "capability_bot_steering",
                "h".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                activeBotPrompt.conversationId,
                "turn_bot_steering",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
                [],
                SessionPromptDisposition.Steer,
                activeBotPrompt.commandId,
            );
            await deliverBotCommand(socket, frames, "delivery_bot_steering", steeringBotPrompt);
            const completedBotCommands = new Set<string>();
            let steeredBotText = "";
            let steeringStopReason = "";
            while (completedBotCommands.size < 2) {
                const envelope = decodeSessionEventEnvelope(await frames.next());
                const payload: unknown = JSON.parse(envelope.payload);
                if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
                    continue;
                }
                const text = Reflect.get(payload, "text");
                if (typeof text === "string") {
                    steeredBotText += text;
                }
                if (decodeMessageKind(envelope.payload) !== SESSION_COMPLETED_KIND) {
                    continue;
                }
                const commandId = Reflect.get(payload, "commandId");
                if (typeof commandId === "string") {
                    completedBotCommands.add(commandId);
                    if (commandId === steeringBotPrompt.commandId) {
                        const stopReason = Reflect.get(payload, "stopReason");
                        steeringStopReason = typeof stopReason === "string" ? stopReason : "";
                    }
                }
            }
            expect(completedBotCommands).toEqual(new Set([activeBotPrompt.commandId, steeringBotPrompt.commandId]));
            expect(steeringStopReason).toBe("steered");
            expect(steeredBotText).toContain("Steered: focus on verified behavior");

            const queuedBotPrompt = new BotSessionPromptCommand(
                activeBotPrompt.sessionId,
                "message_bot_queued",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "run the queued Bot follow-up",
                "execution_bot_queued",
                "capability_bot_queued",
                "i".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                activeBotPrompt.conversationId,
                "turn_bot_queued",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
                [],
                SessionPromptDisposition.Queue,
                activeBotPrompt.commandId,
            );
            await deliverBotCommand(socket, frames, "delivery_bot_queued", queuedBotPrompt);
            expect(await readCompletedText(frames)).toContain("run the queued Bot follow-up");

            await mkdir(join(workspace, "changed-after-selection"));
            const changedContentsPrompt = new BotSessionPromptCommand(
                "session_alpha",
                "message_changed_contents",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "Continue after workspace contents change",
                "execution_changed_contents",
                "capability_changed_contents",
                "e".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_alpha",
                "turn_changed_contents",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(changedContentsPrompt));
            expect(await readCompletedText(frames)).toContain("Continue after workspace contents change");

            await rename(workspace, join(stateDirectory, "workspace-before-replacement"));
            await mkdir(workspace);
            const replacedTargetPrompt = new BotSessionPromptCommand(
                "session_alpha",
                "message_replaced_target",
                "codex",
                binding.bindingId,
                "default",
                [],
                [],
                [],
                "Continue after workspace replacement",
                "execution_replaced_target",
                "capability_replaced_target",
                "g".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                binding.botId,
                "conversation_alpha",
                "turn_replaced_target",
                binding.behaviorRevisionId,
                binding.bindingRevision,
                binding.behaviorInstructions,
                binding.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedExecutionConfiguration,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(replacedTargetPrompt));
            expect(await readCompletedText(frames)).toContain("Continue after workspace replacement");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            restore("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restore("MOBIUS_FAKE_ACP_STATE_DIRECTORY", previousNativeDirectory);
            restore("NO_PROXY", previousNoProxy);
            restore("no_proxy", previousLowerNoProxy);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
