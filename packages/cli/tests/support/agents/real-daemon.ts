import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionReadyEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionPrepareCommand,
    MOBIUS_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_LIVENESS_READY_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { type WebSocket, WebSocketServer } from "ws";
import { openMobiusCliInstallation } from "../../../src/daemon/pairing/pair-local-machine.ts";
import type { LocalAgentSpecification } from "../../../src/runtime/agent-catalog/agent-specification.ts";
import { discoverLocalAgentInventory } from "../../../src/runtime/agent-catalog/discover-local-agents.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../../src/runtime/config.ts";
import { runRuntime } from "../../../src/runtime/run.ts";

export interface RealDaemonPeer {
    readonly restart: () => Promise<void>;
    readonly send: (message: string) => void;
    readonly sessionId: string;
    readonly workspace: string;
    readonly bindingId: string;
    readonly readDiagnostics: () => Promise<string>;
    readonly signal: AbortSignal;
    readonly nextEvent: () => Promise<string>;
    readonly nextMessage: () => Promise<string>;
}

/** Production daemon and discovery; the peer only sends and observes the public protocol. */
export async function withRealDaemon(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
    workspaceDirectory?: string,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), `mobius-real-${specification.id}-`));
    const workspace = workspaceDirectory ?? join(directory, "workspace");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const catalogs = new Map<string, string>();
    const relay = createServer((request, response) => {
        if (request.method === "PUT" && request.url?.endsWith("/catalog")) {
            const path = request.url;
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                catalogs.set(path, body);
                response.writeHead(204).end();
            });
        } else if (request.method === "GET" && request.url !== undefined && catalogs.has(request.url)) {
            response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(request.url));
        } else {
            response.writeHead(404).end();
        }
    });
    const server = new WebSocketServer({ server: relay });
    let runtime: Promise<void> | undefined;
    let execution = new AbortController();
    const cliEnvironment = { ...process.env, ...environment, MOBIUS_STATE_DIRECTORY: directory };
    const cli = async (args: readonly string[], deadline = signal): Promise<void> => {
        const child = spawn(
            process.execPath,
            [resolve(import.meta.dirname, "../../../src/entrypoint/cli.ts"), ...args],
            {
                env: cliEnvironment,
                signal: deadline,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        await new Promise<void>((resolve_, reject) => {
            child.once("error", reject);
            child.once("close", (code) =>
                code === 0 ? resolve_() : reject(new Error(`CLI ${args.join(" ")} failed: ${output}`)),
            );
        });
    };
    let socket: WebSocket | undefined;
    const messages: string[] = [];
    let waiter: PromiseWithResolvers<string> | undefined;
    const stopWaiting = (): void => waiter?.reject(signal.reason);
    signal.addEventListener("abort", stopWaiting, { once: true });
    try {
        await mkdir(workspace, { recursive: true });
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
        let connected = Promise.withResolvers<void>();
        const abortConnection = (): void => connected.reject(signal.reason);
        signal.addEventListener("abort", abortConnection, { once: true });
        server.on("connection", (connection) => {
            socket = connection;
            connection.on("message", (value) => {
                const message = value.toString();
                // Like the Relay's host, answer exactly the heartbeat text without the application.
                if (message === RUNTIME_HEARTBEAT_MESSAGE) {
                    connection.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
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
        const config = createRuntimeConfig(
            { channelId: "real-agent", defaultWorkspace: workspace, relayUrl },
            [agent],
            new RuntimeLocalContext(directory, { ...process.env, ...environment }),
        );
        if (launch === "managed") {
            const installation = await openMobiusCliInstallation(signal, cliEnvironment);
            await installation.saveConnection(
                {
                    appId: "app_real",
                    channelId: "real-agent",
                    defaultWorkspace: workspace,
                    pairingId: "",
                    relayOrigin: new URL(`http://127.0.0.1:${port(relay)}`),
                    runtimeCredential: "r".repeat(43),
                    runtimeId: "runtime_real",
                },
                signal,
            );
        }
        const start = async (): Promise<void> => {
            if (launch === "managed") {
                await cli(["start"]);
            } else {
                execution = new AbortController();
                runtime = runRuntime(config, AbortSignal.any([signal, execution.signal]));
                void runtime.catch((error: unknown) => {
                    connected.reject(error);
                    waiter?.reject(error);
                });
            }
        };
        await start();
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
        const sessionId = `real_${specification.id}_${randomUUID()}`;
        await scenario({
            restart: async () => {
                if (launch === "managed") {
                    await cli(["quit"]);
                } else {
                    execution.abort();
                    await runtime;
                }
                messages.length = 0;
                pendingEvents.length = 0;
                connected = Promise.withResolvers<void>();
                await start();
                await connected.promise;
            },
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
                            ...decodeSessionEventEnvelope(message).events.map((event) => JSON.stringify(event)),
                        );
                        const event = pendingEvents.shift();
                        if (event !== undefined) {
                            return event;
                        }
                    }
                }
            },
        });
    } finally {
        if (launch === "managed") {
            await cli(["quit"], AbortSignal.timeout(15_000));
        }
        controller.abort();
        signal.removeEventListener("abort", stopWaiting);
        await runtime?.catch(() => {});
        for (const connection of server.clients) {
            connection.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (relay.listening) {
            await new Promise<void>((resolve) => relay.close(() => resolve()));
        }
        await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
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
