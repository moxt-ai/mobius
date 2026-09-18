import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionEventAcknowledgement,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    type SessionConfigurationSelection,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import { LocalAgentDefinition } from "../src/agent-catalog/local-agent.ts";
import { AuditStore } from "../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../src/config.ts";
import { runDaemon } from "../src/run-daemon.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
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
        throw new Error("Test relay did not bind to a TCP port");
    }
    return address.port;
}

function writeServerTextFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, "utf8");
    const header =
        payload.byteLength < 126
            ? Buffer.from([0x81, payload.byteLength])
            : Buffer.from([0x81, 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
    socket.write(Buffer.concat([header, payload]));
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
                writeServerTextFrame(
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

async function readTerminalSessionResult(frames: ClientFrames, sessionId: string): Promise<TerminalSessionResult> {
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
        text += readStringField(payload, "text");
        if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
            return new TerminalSessionResult(kind, text, readStringField(payload, "code"));
        }
    }
}

describe("daemon session configuration boundary", () => {
    it("Given a conversation changes its local permission mode, When the next configured turn runs, Then Mobius resumes the conversation in the selected environment", async () => {
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

        const relayUrl = new URL(`ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
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
            const firstSessionConfigurations: readonly SessionConfigurationSelection[] = [
                {
                    booleanValue: false,
                    configId: "permission_mode",
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
            writeServerTextFrame(await socketReady.promise, encodeSessionPromptCommand(firstPrompt));
            const firstResult = await readTerminalSessionResult(frames, firstPrompt.sessionId);
            expect(firstResult).toMatchObject({
                kind: SESSION_COMPLETED_KIND,
                text: "DeepSeek Harness turn 1: first configured turn",
            });

            const secondPrompt: SessionPromptCommand = {
                ...firstPrompt,
                commandId: "second_configured_turn",
                prompt: "second configured turn",
                sessionConfigurations: firstSessionConfigurations.map((selection) =>
                    selection.configId === "permission_mode" ? { ...selection, value: "workspace-write" } : selection,
                ),
            };
            writeServerTextFrame(await socketReady.promise, encodeSessionPromptCommand(secondPrompt));
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
});
