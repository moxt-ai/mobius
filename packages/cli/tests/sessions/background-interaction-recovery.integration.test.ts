import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
    decodeDaemonToServiceMessage,
    encodeNativeSessionRequest,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    MOBIUS_API_PREFIX,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type { AcpEndpointTermination } from "../../src/engine/acp/agent/in-process-endpoint.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledEndpointConnection } from "../support/agents/controlled-endpoint-connection.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";

test("Given a completed foreground turn, When its Agent requests background permission, Then the session snapshot recovers that request and removes it after the user responds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "mobius-background-interaction-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const server = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    const frames: string[] = [];
    const readers: Array<(frame: string) => void> = [];
    server.on("connection", (socket) => {
        socket.on("message", (data) => {
            if (data.toString().includes('"kind":"runtime.heartbeat"')) {
                socket.send(JSON.stringify({ kind: "runtime.heartbeat.ack" }));
                return;
            }
            const reader = readers.shift();
            if (reader === undefined) {
                frames.push(data.toString());
            } else {
                reader(data.toString());
            }
        });
        connected.resolve(socket);
    });
    const next = async () =>
        decodeDaemonToServiceMessage(frames.shift() ?? (await new Promise<string>((resolve) => readers.push(resolve))));
    const live = async (kind: string): Promise<SessionLiveEvent> => {
        for (;;) {
            const message = await next();
            if (message.kind !== SESSION_EVENT_KIND) {
                continue;
            }
            const event = message.events.find(
                (event) => event.type === "lifecycle-metadata" && event.payload.kind === kind,
            );
            if (event !== undefined) {
                return event;
            }
        }
    };
    let requestPermission: () => Promise<acp.RequestPermissionResponse> = async () => {
        throw new Error("The Agent has not completed a foreground prompt");
    };
    const agent = new AcpAgentDefinition("claude", "Controlled background Agent", process.execPath, (options) => {
        const terminated = Promise.withResolvers<AcpEndpointTermination>();
        let connection: acp.AgentConnection | null = null;
        const app = acp
            .agent({ name: "background-interaction" })
            .onConnect((value) => {
                connection = value;
            })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: false, sessionCapabilities: { close: {}, resume: {} } },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
            .onRequest(acp.methods.agent.session.resume, () => ({}))
            .onRequest(acp.methods.agent.session.close, () => ({}))
            .onRequest(acp.methods.agent.session.prompt, (context) => {
                requestPermission = () =>
                    context.client.request(acp.methods.client.session.requestPermission, {
                        sessionId: context.params.sessionId,
                        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
                        toolCall: {
                            toolCallId: "background-tool",
                            kind: "execute",
                            title: "Background verification",
                            status: "pending",
                            rawInput: { command: "echo verified" },
                        },
                    });
                return { stopReason: "end_turn" };
            });
        return new ControlledEndpointConnection(
            {
                app: () => app,
                initialize: async (signal) => signal.throwIfAborted(),
                terminated: terminated.promise,
                close: async () => {
                    connection?.close();
                    terminated.resolve({ kind: "closed" });
                },
            },
            options.client,
        );
    });
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/background/daemon`);
    relayUrl.searchParams.set("token", "r".repeat(43));
    const config = createControlledRuntimeConfig(
        { channelId: "background", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(directory, process.env),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "background_interaction";
        const identity = {
            additionalDirectoryIds: [],
            agentId: "claude",
            bindingId: config.bindingId,
            directoryId: "default",
            sessionId,
        };
        socket.send(
            encodeSessionPrepareCommand({
                ...identity,
                kind: "session.prepare",
                requestId: "prepare",
                transient: true,
            }),
        );
        while ((await next()).kind !== "session.ready") {
            /* Wait for the public readiness response. */
        }
        socket.send(
            encodeSessionPromptCommand({
                ...identity,
                commandId: "foreground",
                disposition: "reject",
                attachments: [],
                kind: "session.prompt",
                prompt: "Finish before the background approval",
                targetCommandId: "",
            }),
        );
        await live("prompt.completed");
        const response = requestPermission();
        void response.catch(() => undefined);
        const requested = await live("session.permission.requested");
        if (requested.type !== "lifecycle-metadata" || requested.payload.kind !== "session.permission.requested") {
            throw new Error("Missing permission event");
        }
        expect(requested.payload.event.commandId).toBe("session-control");
        const snapshot = async (requestId: string) => {
            socket.send(
                encodeNativeSessionRequest({
                    ...identity,
                    action: "active-turn",
                    kind: "native.session.request",
                    requestId,
                    targetSessionId: sessionId,
                }),
            );
            for (;;) {
                const result = await next();
                if (result.kind === "native.session.result" && result.requestId === requestId) {
                    return result;
                }
            }
        };
        expect(await snapshot("pending")).toMatchObject({
            action: "active-turn",
            turn: null,
            interactionState: {
                sessionGenerationId: requested.sessionGenerationId,
                throughPosition: requested.position,
                interactions: [requested.payload.event],
            },
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                sessionId,
                interactionId: requested.payload.event.interactionId,
                kind: "session.permission.respond",
                optionId: "allow-once",
                outcome: "selected",
            }),
        );
        await expect(response).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
        const resolved = await live("session.permission.resolved");
        expect(await snapshot("resolved")).toMatchObject({
            turn: null,
            interactionState: {
                sessionGenerationId: resolved.sessionGenerationId,
                throughPosition: resolved.position,
                interactions: [],
            },
        });
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of server.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
});
