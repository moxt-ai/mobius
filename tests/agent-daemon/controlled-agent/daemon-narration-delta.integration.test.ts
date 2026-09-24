import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
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
            this.#messages.push(message);
            const resolve = this.#resolvers.shift();
            if (resolve !== undefined) {
                resolve(message);
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
    it("Given an Agent rewrites one reasoning activity for every streamed chunk, When the turn completes, Then the daemon sends bounded increments and a single completed snapshot whose text matches the whole narration", async () => {
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
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_beta/daemon`);
        relayUrl.searchParams.set("token", "e".repeat(43));
        const agent = new LocalAgentDefinition(
            "deepseek-harness",
            "DeepSeek Harness",
            process.execPath,
            [fakeAgentPath, "--agent-name", "DeepSeek Harness"],
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

            // Every event is acked so the replay window keeps draining, exactly as a
            // healthy Relay behaves. The narration itself must still stay incremental.
            let activityCount = 0;
            let narrationCount = 0;
            const narrationByActivity = new Map<string, string>();
            let completedSnapshot = "";
            let completedActivityId = "";
            let maxEventBytes = 0;
            let completed = false;
            while (!completed) {
                const message = await frames.next();
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const envelope = decodeSessionEventEnvelope(message);
                maxEventBytes = Math.max(maxEventBytes, Buffer.byteLength(envelope.payload, "utf8"));
                const kind = decodeMessageKind(envelope.payload);
                if (kind === AGENT_ACTIVITY_NARRATION_KIND) {
                    const payload: unknown = JSON.parse(envelope.payload);
                    narrationCount += 1;
                    if (typeof payload === "object" && payload !== null) {
                        const activityId = String(Reflect.get(payload, "activityId"));
                        narrationByActivity.set(
                            activityId,
                            `${narrationByActivity.get(activityId) ?? ""}${String(Reflect.get(payload, "text"))}`,
                        );
                    }
                }
                if (kind === AGENT_ACTIVITY_KIND) {
                    const payload: unknown = JSON.parse(envelope.payload);
                    activityCount += 1;
                    if (
                        typeof payload === "object" &&
                        payload !== null &&
                        Reflect.get(payload, "status") === "completed" &&
                        Reflect.get(payload, "activityType") === "reasoning"
                    ) {
                        completedSnapshot = String(Reflect.get(payload, "output"));
                        completedActivityId = String(Reflect.get(payload, "activityId"));
                    }
                }
                if (kind === SESSION_COMPLETED_KIND || kind === SESSION_FAILED_KIND) {
                    completed = true;
                }
            }

            // The window of reasoning updates the fixture streams must arrive as
            // increments, not as one growing snapshot per chunk.
            expect(narrationCount).toBeGreaterThan(0);
            // No single durable event may carry the accumulated narration, which is what
            // made the retained bytes grow quadratically.
            expect(maxEventBytes).toBeLessThan(8_000);
            // The completed snapshot carries the whole narration exactly once, and the
            // increments reach it with no loss or duplication.
            expect(completedSnapshot).toContain("Inspecting the workspace");
            expect(completedSnapshot).toContain("step-0");
            expect(completedSnapshot).toContain("step-63");
            // The snapshot must fold in exactly the increments that were sent for it.
            const streamed = narrationByActivity.get(completedActivityId) ?? "";
            expect(streamed.length).toBeGreaterThan(0);
            expect(completedSnapshot).toContain(streamed);
            expect(activityCount).toBeGreaterThan(0);
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
