import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentMessageDeltaEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionStartedEvent,
    encodeNativeSessionCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { CodexAcpAgent } from "../../../packages/cli/src/acp/codex/agent.ts";
import { InProcessAcpAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port } from "../../../tests/infra/websocket.ts";
import { CodexFixture } from "../infra/codex.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

class Messages {
    readonly #buffered: string[] = [];
    readonly #waiting: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        socket.on("message", (value) => {
            const message = value.toString();
            const resolve = this.#waiting.shift();
            if (resolve === undefined) {
                this.#buffered.push(message);
            } else {
                resolve(message);
            }
        });
    }

    readonly next = (): Promise<string> => {
        const buffered = this.#buffered.shift();
        return buffered === undefined
            ? new Promise<string>((resolve) => this.#waiting.push(resolve))
            : Promise.resolve(buffered);
    };
}

test("Given real Codex and a local model provider, When a Turn streams, Then the daemon accepts it before ordered text and completion", async () => {
    const providerEntered = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const provider = await FakeOpenAiProvider.start("mobius-test-model", "Codex live reply", {
        beforeFirstText: async () => {
            providerEntered.resolve();
            await releaseProvider.promise;
        },
    });
    const codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-real-codex-live-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/real-codex/daemon`);
    relayUrl.searchParams.set("token", "r".repeat(43));
    const agent = new InProcessAcpAgentDefinition(
        "codex",
        "Codex",
        codex.executable,
        (options) => new CodexAcpAgent(options),
        codex.environment,
    );
    const config = createDaemonConfig(
        { channelId: "real-codex", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal);

    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        const commandId = randomUUID();
        const sessionId = "new_codex_live_turn";
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "Reply briefly using the configured model",
                resources: [],
                sessionId,
                targetCommandId: "",
            }),
        );
        let started = false;
        let completed = false;
        let sequence = 0;
        let epoch: string | undefined;
        let snapshotVerified = false;
        let text = "";
        while (!completed) {
            const message = await messages.next();
            if (decodeMessageKind(message) === NATIVE_SESSION_RESULT_KIND) {
                const result = decodeNativeSessionResult(message);
                expect(result.action).toBe("active-turn");
                if (result.action === "active-turn") {
                    expect(result.turn).toMatchObject({
                        commandId,
                        epoch: expect.any(String),
                        prompt: "Reply briefly using the configured model",
                        sequence: 0,
                        state: "running",
                        text: "",
                    });
                }
                snapshotVerified = true;
                releaseProvider.resolve();
                continue;
            }
            if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                continue;
            }
            const envelope = decodeSessionEventEnvelope(message);
            socket.send(
                encodeSessionEventAcknowledgement({
                    eventId: envelope.eventId,
                    kind: SESSION_EVENT_ACK_KIND,
                    sessionId: envelope.sessionId,
                }),
            );
            const kind = decodeMessageKind(envelope.payload);
            if (kind === SESSION_STARTED_KIND) {
                expect(started).toBe(false);
                expect(decodeSessionStartedEvent(envelope.payload)).toMatchObject({
                    commandId,
                    epoch: expect.any(String),
                    prompt: "Reply briefly using the configured model",
                    sequence: 0,
                });
                started = true;
                await providerEntered.promise;
                socket.send(
                    encodeNativeSessionCommand({
                        action: "active-turn",
                        additionalDirectoryIds: [],
                        agentId: "codex",
                        bindingId: config.bindingId,
                        directoryId: "default",
                        kind: "native.session.request",
                        requestId: randomUUID(),
                        sessionId,
                        targetSessionId: sessionId,
                    }),
                );
            } else if (kind === AGENT_MESSAGE_DELTA_KIND) {
                expect(started).toBe(true);
                const delta = decodeAgentMessageDeltaEvent(envelope.payload);
                expect(delta.commandId).toBe(commandId);
                expect(delta.sequence).toBe(sequence + 1);
                expect(epoch === undefined || delta.epoch === epoch).toBe(true);
                epoch = delta.epoch;
                sequence = delta.sequence;
                text += delta.text;
            } else if (kind === SESSION_COMPLETED_KIND) {
                completed = true;
            } else if (kind === SESSION_FAILED_KIND) {
                throw new Error(`Real Codex Turn failed: ${envelope.payload}`);
            }
        }
        expect(started).toBe(true);
        expect(snapshotVerified).toBe(true);
        expect(sequence).toBeGreaterThan(0);
        expect(text).toContain("Codex live reply");
    } finally {
        releaseProvider.resolve();
        cancellation.abort();
        await daemon;
        audit.close();
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { force: true, recursive: true });
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
    }
}, 120_000);
