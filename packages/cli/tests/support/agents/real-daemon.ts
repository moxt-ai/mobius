import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveEventEnvelopeV3,
    decodeSessionReadyEvent,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionPrepareCommand,
    MOBIUS_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type SessionLiveEventV3,
} from "@moxt-ai/mobius-protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { type WebSocket, WebSocketServer } from "ws";
import type { LocalAgentSpecification } from "../../../src/agent-catalog/agent-specification.ts";
import { discoverLocalAgentInventory } from "../../../src/agent-catalog/discover-local-agents.ts";
import { AuditStore } from "../../../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../src/config.ts";
import { runDaemon } from "../../../src/run-daemon.ts";

export interface RealDaemonPeer {
    readonly send: (message: string) => void;
    readonly sessionId: string;
    readonly workspace: string;
    readonly bindingId: string;
    readonly readDiagnostics: () => Promise<string>;
    readonly signal: AbortSignal;
    readonly nextEvent: () => Promise<string>;
    readonly nextLiveEventV3: () => Promise<SessionLiveEventV3>;
    readonly nextMessage: () => Promise<string>;
}

/** Production daemon and discovery; the peer only sends and observes the public protocol. */
export async function withRealDaemon(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), `mobius-real-${specification.id}-`));
    const workspace = join(directory, "workspace");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const server = new WebSocketServer({ server: relay });
    let daemon: Promise<void> | undefined;
    let socket: WebSocket | undefined;
    const messages: string[] = [];
    let waiter: PromiseWithResolvers<string> | undefined;
    const stopWaiting = (): void => waiter?.reject(signal.reason);
    signal.addEventListener("abort", stopWaiting, { once: true });
    try {
        await mkdir(workspace);
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment: { ...process.env, ...environment, MOBIUS_STATE_DIRECTORY: directory },
            signal,
            specifications: [specification],
        });
        const agent = inventory.readyAgents().find((entry) => entry.id === specification.id);
        if (agent === undefined) {
            throw new Error(`Real ${specification.label} unavailable: ${JSON.stringify(inventory.unavailable)}`);
        }
        await listen(relay);
        const connected = Promise.withResolvers<void>();
        const abortConnection = (): void => connected.reject(signal.reason);
        signal.addEventListener("abort", abortConnection, { once: true });
        server.on("connection", (connection) => {
            socket = connection;
            connection.on("message", (value) => {
                const message = value.toString();
                if (decodeMessageKind(message) === RUNTIME_HEARTBEAT_KIND) {
                    const heartbeat = decodeRuntimeHeartbeatEvent(message);
                    connection.send(
                        encodeRuntimeHeartbeatAckEvent({
                            heartbeatId: heartbeat.heartbeatId,
                            kind: RUNTIME_HEARTBEAT_ACK_KIND,
                        }),
                    );
                    return;
                }

                if (waiter === undefined) {
                    messages.push(message);
                } else {
                    const pending = waiter;
                    waiter = undefined;
                    pending.resolve(message);
                }
            });
            connection.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
            connected.resolve();
        });
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/real-agent/daemon`);
        relayUrl.searchParams.set("token", "r".repeat(43));
        const config = createDaemonConfig(
            { channelId: "real-agent", defaultWorkspace: workspace, relayUrl },
            [agent],
            [],
            new DaemonLocalContext(directory, { ...process.env, ...environment }),
        );
        daemon = runDaemon(config, new AuditStore(), signal);
        void daemon.catch((error: unknown) => {
            connected.reject(error);
            waiter?.reject(error);
        });
        try {
            await connected.promise;
        } finally {
            signal.removeEventListener("abort", abortConnection);
        }
        const nextMessage = async (): Promise<string> => {
            signal.throwIfAborted();
            const message = messages.shift();
            if (message !== undefined) {
                return message;
            }
            waiter = Promise.withResolvers<string>();
            return await waiter.promise;
        };
        const pendingEvents: string[] = [];
        const pendingLiveEventsV3: SessionLiveEventV3[] = [];
        const sessionId = `real_${specification.id}_${randomUUID()}`;
        await scenario({
            bindingId: config.bindingId,
            readDiagnostics: async () => await readFile(join(directory, "logs", "daemon.log"), "utf8"),
            signal,
            sessionId,
            workspace,
            send: (message) => {
                if (socket === undefined) {
                    throw new Error("Daemon is not connected");
                }
                socket.send(message);
            },
            nextMessage,
            nextEvent: async () => {
                const pending = pendingEvents.shift();
                if (pending !== undefined) {
                    return pending;
                }
                for (;;) {
                    const message = await nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        pendingEvents.push(
                            ...decodeSessionEventEnvelopeV2(message).events.map((event) => JSON.stringify(event)),
                        );
                        const event = pendingEvents.shift();
                        if (event !== undefined) {
                            return event;
                        }
                    }
                }
            },
            nextLiveEventV3: async () => {
                const pending = pendingLiveEventsV3.shift();
                if (pending !== undefined) {
                    return pending;
                }
                for (;;) {
                    const message = await nextMessage();
                    if (decodeMessageKind(message) === "session.live.v3") {
                        pendingLiveEventsV3.push(...decodeSessionLiveEventEnvelopeV3(message).events);
                        const event = pendingLiveEventsV3.shift();
                        if (event !== undefined) {
                            return event;
                        }
                    }
                }
            },
        });
    } finally {
        controller.abort();
        signal.removeEventListener("abort", stopWaiting);
        await daemon?.catch(() => {});
        for (const connection of server.clients) {
            connection.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (relay.listening) {
            await new Promise<void>((resolve) => relay.close(() => resolve()));
        }
        await rm(directory, { recursive: true, force: true });
    }
}

/** Opens a new conversation through the same preparation command the Web uses. */
export async function prepareNewRealSession(
    peer: Parameters<Parameters<typeof withRealDaemon>[2]>[0],
    agentId: string,
): Promise<string> {
    const requestId = randomUUID();
    const sessionId = `draft-${randomUUID()}`;
    peer.send(
        encodeSessionPrepareCommand({
            kind: "session.prepare",
            requestId,
            sessionId,
            agentId,
            bindingId: peer.bindingId,
            directoryId: "default",
            additionalDirectoryIds: [],
        }),
    );
    for (;;) {
        peer.signal.throwIfAborted();
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                return ready.sessionId;
            }
        }
    }
}
