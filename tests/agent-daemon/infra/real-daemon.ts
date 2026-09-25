import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessageKind, decodeSessionEventEnvelope, MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { LocalAgentSpecification } from "../../../packages/cli/src/agent-catalog/agent-specification.ts";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port } from "../../infra/websocket.ts";

/** Production daemon and discovery; the peer only sends and observes the public protocol. */
export async function withRealDaemon(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: {
        readonly send: (message: string) => void;
        readonly sessionId: string;
        readonly workspace: string;
        readonly bindingId: string;
        readonly nextEvent: () => Promise<string>;
        readonly nextMessage: () => Promise<string>;
    }) => Promise<void>,
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

                if (waiter === undefined) {
                    messages.push(message);
                } else {
                    const pending = waiter;
                    waiter = undefined;
                    pending.resolve(message);
                }
            });
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
        const sessionId = `real_${specification.id}_${randomUUID()}`;
        await scenario({
            bindingId: config.bindingId,
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
                for (;;) {
                    const message = await nextMessage();
                    if (decodeMessageKind(message) === "session.event") {
                        return decodeSessionEventEnvelope(message).payload;
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
