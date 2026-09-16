import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
    BotExecutionBindingApprovalRequest,
    BotSessionPromptCommand,
    decodeBotExecutionBindingApprovedEvent,
    decodeMessageKind,
    decodeRuntimeDeliveryReceived,
    decodeSessionConfigUpdatedEvent,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeBotExecutionBindingApprovalRequest,
    encodeBotExecutionBindingApprovedEvent,
    encodeBotSessionPromptCommand,
    encodeRuntimeDelivery,
    encodeRuntimeDeliveryCommitted,
    encodeSessionConfigureCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionPrepareCommand,
    MOBIUS_API_PREFIX,
    NoBotCompletionDeliveryPolicy,
    OwnerBotReplyRoute,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_CONFIG_UPDATED_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_READY_KIND,
    SESSION_STARTED_KIND,
    type SessionConfigurationSelection,
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

describe("daemon Bot execution boundary", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    });
    afterEach(() => vi.useRealTimers());
    it("Given a Bot conversation loses local approval after its workspace changes, When its owner runs bot approve and sends another turn, Then the same Bot and conversation execute again", async () => {
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
            const selectedConfigurations: readonly SessionConfigurationSelection[] = [
                {
                    booleanValue: false,
                    configId: "model",
                    value: "test-large",
                    valueType: "select",
                },
            ];
            const proposal = new BotExecutionBindingApprovalRequest(
                "approval_alpha",
                "bot_alpha",
                "behavior_alpha",
                "binding_alpha",
                1,
                "runtime_alpha",
                "codex",
                "default",
                1,
                "Follow the approved Bot behavior.",
                "a".repeat(64),
                ["embedded-context"],
                [],
                new NoBotCompletionDeliveryPolicy(),
                selectedConfigurations,
            );
            const approvalFrame = frames.next();
            writeServerTextFrame(socket, encodeBotExecutionBindingApprovalRequest(proposal));
            const approvalPayload = await approvalFrame;
            expect(JSON.parse(approvalPayload)).toHaveProperty("localGrantId");
            const approved = decodeBotExecutionBindingApprovedEvent(approvalPayload);
            writeServerTextFrame(socket, encodeBotExecutionBindingApprovedEvent(approved));
            expect(approved).toMatchObject({
                behaviorRevisionId: proposal.behaviorRevisionId,
                bindingId: proposal.bindingId,
                botId: proposal.botId,
            });

            const overrideDirectoryId = `path-${Buffer.from(overrideWorkspace, "utf8").toString("base64url")}`;
            const unpreparedOverride = new BotSessionPromptCommand(
                "session_override",
                "message_unprepared_override",
                "codex",
                proposal.bindingId,
                overrideDirectoryId,
                [],
                [],
                [],
                "Must require local preparation",
                "execution_unprepared_override",
                "capability_unprepared_override",
                "b".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_override",
                "turn_unprepared_override",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(unpreparedOverride));
            const unpreparedFailure = decodeSessionEventEnvelope(await frames.next());
            expect(decodeMessageKind(unpreparedFailure.payload)).toBe(SESSION_FAILED_KIND);
            expect(JSON.parse(unpreparedFailure.payload)).toMatchObject({
                code: "local_approval_required",
                commandId: unpreparedOverride.commandId,
                sessionId: unpreparedOverride.sessionId,
            });

            writeServerTextFrame(
                socket,
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: config.bindingId,
                    directoryId: overrideDirectoryId,
                    kind: SESSION_PREPARE_KIND,
                    requestId: "prepare_override",
                    sessionId: unpreparedOverride.sessionId,
                }),
            );
            const announcedConfigEnvelope = decodeSessionEventEnvelope(await frames.next());
            expect(decodeMessageKind(announcedConfigEnvelope.payload)).toBe(SESSION_CONFIG_UPDATED_KIND);
            expect(announcedConfigEnvelope.source.kind).toBe("runtime");
            const readyEnvelope = decodeSessionEventEnvelope(await frames.next());
            expect(decodeMessageKind(readyEnvelope.payload)).toBe(SESSION_READY_KIND);
            const ready = decodeSessionReadyEvent(readyEnvelope.payload);
            expect(ready).toMatchObject({
                agentId: "codex",
                directoryId: overrideDirectoryId,
                sessionId: unpreparedOverride.sessionId,
            });
            expect(decodeSessionReadyEvent(await frames.next())).toMatchObject({
                requestId: "prepare_override",
                runtimeTimings: expect.arrayContaining([
                    expect.objectContaining({ name: "prepare-total" }),
                    expect.objectContaining({ name: "workspace-resolve" }),
                    expect.objectContaining({ name: "session-state-read" }),
                    expect.objectContaining({ name: "executable-validation" }),
                    expect.objectContaining({ name: "process-spawn" }),
                    expect.objectContaining({ name: "agent-initialize" }),
                    expect.objectContaining({ name: "session-new" }),
                    expect.objectContaining({ name: "workspace-list" }),
                    expect.objectContaining({ name: "readiness-commit" }),
                ]),
                sessionId: unpreparedOverride.sessionId,
            });

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

            writeServerTextFrame(
                socket,
                encodeSessionConfigureCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: config.bindingId,
                    booleanValue: false,
                    configId: "model",
                    directoryId: overrideDirectoryId,
                    kind: SESSION_CONFIGURE_KIND,
                    requestId: "configure_override_model",
                    sessionId: unpreparedOverride.sessionId,
                    value: "test-large",
                    valueType: "select",
                }),
            );
            const configuredEnvelope = decodeSessionEventEnvelope(await frames.next());
            expect(decodeMessageKind(configuredEnvelope.payload)).toBe(SESSION_CONFIG_UPDATED_KIND);
            expect(decodeSessionConfigUpdatedEvent(configuredEnvelope.payload).configOptions).toEqual(
                expect.arrayContaining([expect.objectContaining({ currentValue: "test-large", id: "model" })]),
            );

            const preparedOverride = new BotSessionPromptCommand(
                unpreparedOverride.sessionId,
                "message_prepared_override",
                "codex",
                proposal.bindingId,
                overrideDirectoryId,
                [],
                [],
                [],
                "Report Bot execution settings",
                "execution_prepared_override",
                "capability_prepared_override",
                "f".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_override",
                "turn_prepared_override",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(preparedOverride));
            expect(await readCompletedText(frames)).toBe(
                `test-large|${await realpath(overrideWorkspace)}|bot-context|relay-cleared`,
            );

            const configuredBotPrompt = new BotSessionPromptCommand(
                "session_bot_configuration",
                "message_bot_configuration",
                "codex",
                proposal.bindingId,
                "default",
                [],
                [],
                [],
                "Report Bot execution settings",
                "execution_bot_configuration",
                "capability_bot_configuration",
                "d".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_alpha",
                "turn_bot_configuration",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(configuredBotPrompt));
            expect(await readCompletedText(frames)).toBe(
                `test-large|${await realpath(workspace)}|bot-context|relay-cleared`,
            );

            const prompt = new BotSessionPromptCommand(
                "session_alpha",
                "message_alpha",
                "codex",
                proposal.bindingId,
                "default",
                [],
                [],
                [],
                "Report prompt blocks",
                "execution_alpha",
                "capability_alpha",
                "c".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_alpha",
                "turn_alpha",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
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

            const database = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(
                    database
                        .prepare(
                            "SELECT bot_id, behavior_revision_id, binding_id, workspace_path FROM local_bot_grants",
                        )
                        .get(),
                ).toMatchObject({
                    behavior_revision_id: proposal.behaviorRevisionId,
                    binding_id: proposal.bindingId,
                    bot_id: proposal.botId,
                    workspace_path: await realpath(workspace),
                });
            } finally {
                database.close();
            }

            await mkdir(join(workspace, "changed-after-approval"));
            const changedTargetPrompt = new BotSessionPromptCommand(
                "session_alpha",
                "message_changed_target",
                "codex",
                proposal.bindingId,
                "default",
                [],
                [],
                [],
                "Must require reapproval",
                "execution_changed_target",
                "capability_changed_target",
                "e".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_alpha",
                "turn_changed_target",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(changedTargetPrompt));
            const failure = decodeSessionEventEnvelope(await frames.next());
            expect(decodeMessageKind(failure.payload)).toBe(SESSION_FAILED_KIND);
            const failurePayload: unknown = JSON.parse(failure.payload);
            expect(failurePayload).toMatchObject({
                code: "binding_not_approved",
                commandId: changedTargetPrompt.commandId,
                sessionId: changedTargetPrompt.sessionId,
            });
            const revokedDatabase = new DatabaseSync(auditDatabasePath, { readOnly: true });
            try {
                expect(
                    revokedDatabase
                        .prepare("SELECT revocation_epoch, revoked_at FROM local_bot_grants WHERE local_grant_id = ?")
                        .get(approved.localGrantId),
                ).toMatchObject({ revocation_epoch: 1 });
            } finally {
                revokedDatabase.close();
            }
            await expect(
                promisify(execFile)(
                    process.execPath,
                    [
                        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                        "bot",
                        "approve",
                        "--bot",
                        "bot_unknown",
                    ],
                    { env: environment, signal: AbortSignal.timeout(20_000) },
                ),
            ).rejects.toMatchObject({
                stderr: expect.stringContaining("bot_not_found"),
            });
            const result = await promisify(execFile)(
                process.execPath,
                [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "bot", "approve", "--bot", proposal.botId],
                { env: environment, signal: AbortSignal.timeout(20_000) },
            );
            expect(result.stdout).toContain("Approved Bot bot_alpha");
            const retry = new BotSessionPromptCommand(
                changedTargetPrompt.sessionId,
                "message_after_approval",
                "codex",
                proposal.bindingId,
                "default",
                [],
                [],
                [],
                "Recovered",
                "execution_after_approval",
                "capability_after_approval",
                "f".repeat(43),
                new Date(Date.now() + 60_000).toISOString(),
                proposal.botId,
                "conversation_alpha",
                "turn_after_approval",
                proposal.behaviorRevisionId,
                proposal.bindingRevision,
                approved.localGrantId,
                proposal.behaviorInstructions,
                proposal.behaviorDigest,
                [],
                new OwnerBotReplyRoute(),
                selectedConfigurations,
            );
            writeServerTextFrame(socket, encodeBotSessionPromptCommand(retry));
            expect(await readCompletedText(frames)).toContain("Recovered");
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
