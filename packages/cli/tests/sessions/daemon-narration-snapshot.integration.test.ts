import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionEventEnvelopeV2,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_EVENT_V2_KIND,
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

describe("daemon narration delivery", () => {
    it("Given an Agent streams a long reasoning activity, When the turn completes, Then bounded narration increments preserve it without duplicate text", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-narration-delta-"));
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

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_beta/daemon`);
        relayUrl.searchParams.set("token", "e".repeat(43));
        const agent = new LocalAgentDefinition(
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Controlled ACP"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createDaemonConfig(
            {
                channelId: "channel_beta",
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
            const prompt: SessionPromptCommand = {
                additionalDirectoryIds: [],
                agentId: agent.id,
                bindingId: config.bindingId,
                commandId: "narration_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "stream verbose activity",
                resources: [],
                sessionId: "narration_conversation",
                targetCommandId: "",
            };
            sendText(socket, encodeSessionPromptCommand(prompt));

            let narration = "";
            let completedNarration = false;
            for (;;) {
                const message = await frames.next();
                if (decodeMessageKind(message) !== SESSION_EVENT_V2_KIND) {
                    continue;
                }
                const events = decodeSessionEventEnvelopeV2(message).events;
                for (const event of events) {
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_thought_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        narration += event.payload.content.text;
                        completedNarration = true;
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(message);
                    }
                }
                if (
                    events.some(
                        (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                    )
                ) {
                    break;
                }
            }
            expect(completedNarration).toBe(true);
            expect(narration).toContain("Inspecting the workspace");
            expect(narration.split("step-0")).toHaveLength(2);
            expect(narration.split("step-63")).toHaveLength(2);
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
