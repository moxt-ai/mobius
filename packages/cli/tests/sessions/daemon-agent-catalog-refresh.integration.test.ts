import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionOperationFailedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionReadyEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeNativeSessionCommand,
    encodeSessionPrepareCommand,
    encodeSessionPreviewHistoryPageLoad,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_REQUEST_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { expect, test, vi } from "vitest";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import { RuntimeAgentDependencies } from "../../src/engine/agent/runtime-agents.ts";
import type { LocalAgentSpecification } from "../../src/engine/agent/specification/agent-specification.ts";
import { publishAgentCatalog } from "../../src/engine/runtime/catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../src/engine/runtime/catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class RefreshableAgentSpecification extends ControlledAcpSpecification {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp";
    readonly id: string;
    readonly label = "Controlled ACP";
    override readonly maximumTestedAgentVersion = this.adapterVersion;
    override readonly minimumSupportedAgentVersion = this.adapterVersion;

    constructor(id: string) {
        super("MOBIUS_TEST_REFRESHABLE_AGENT_PATH", []);
        this.id = id;
    }
}

// A second ready Agent whose executable never changes, so a refresh of the upgraded Agent must
// keep exactly one catalog entry for it.
class UnchangedPeerAgentSpecification extends ControlledAcpSpecification {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp-peer";
    readonly id = "controlled-acp-peer";
    readonly label = "Controlled ACP Peer";

    constructor() {
        super("MOBIUS_TEST_PEER_PATH", ["--profile", "acp"]);
    }
}

function specifications(agentId: string): readonly LocalAgentSpecification[] {
    return [new RefreshableAgentSpecification(agentId), new UnchangedPeerAgentSpecification()];
}

function launcherSource(version: string, peerUrl: string, nativeSessions = true): string {
    return `#!${process.execPath}
const version = ${JSON.stringify(version)};
if (process.argv.includes("--version")) {
    process.stdout.write(version + "\\n");
    process.exit(0);
}
if (process.argv.includes("app-server")) {
    const { createInterface } = await import("node:readline");
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
            process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        } else if (message.method === "thread/turns/list") {
            const result = {
                data: [{
                    id: "saved-turn", status: "completed",
                    items: [{ id: "saved-answer", type: "agentMessage", text: "History from " + version }],
                }],
                nextCursor: null,
            };
            process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
        } else {
            process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported method" } }) + "\\n");
        }
    });
    await new Promise((resolve) => input.on("close", resolve));
    process.exit(0);
}
process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", version,
    "--no-load-session",
    "--http-mcp",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
);
if (!${JSON.stringify(nativeSessions)}) process.argv.push("--no-native-sessions");
await import(${JSON.stringify(peerUrl)});
`;
}

type PrepareOutcome =
    | {
          readonly kind: "session.operation.failed";
          readonly failure: ReturnType<typeof decodeSessionOperationFailedEvent>;
      }
    | { readonly kind: "session.ready"; readonly ready: ReturnType<typeof decodeSessionReadyEvent> }
    | { readonly kind: "native.session.result"; readonly result: ReturnType<typeof decodeNativeSessionResult> }
    | {
          readonly kind: "session.preview-history.page.loaded";
          readonly preview: ReturnType<typeof decodeSessionPreviewHistoryPageLoaded>;
      }
    | {
          readonly kind: typeof AGENT_SETTINGS_DISCOVERED_KIND;
          readonly discovered: ReturnType<typeof decodeAgentSettingsDiscoveredEvent>;
      };

async function nextCommandOutcome(frames: ClientFrames, requestId: string): Promise<PrepareOutcome> {
    for (;;) {
        const message = await frames.next();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            const failure = decodeSessionOperationFailedEvent(message);
            if (failure.requestId === requestId) {
                return { kind, failure };
            }
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                return { kind, ready };
            }
        }
        if (kind === AGENT_SETTINGS_DISCOVERED_KIND) {
            const discovered = decodeAgentSettingsDiscoveredEvent(message);
            if (discovered.requestId === requestId) {
                return { kind, discovered };
            }
        }
        if (kind === "native.session.result") {
            const result = decodeNativeSessionResult(message);
            if (result.requestId === requestId) {
                return { kind, result };
            }
        }
        if (kind === "session.preview-history.page.loaded") {
            const preview = decodeSessionPreviewHistoryPageLoaded(message);
            if (preview.requestId === requestId) {
                return { kind, preview };
            }
        }
    }
}

class ClientFrames {
    #buffered = Buffer.alloc(0);
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];

    constructor(socket: Duplex) {
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
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(message);
            } else {
                resolve(message);
            }
        }
    };
}

test.for([
    { agentId: "controlled-acp", queryBeforeUpgrade: false },
    { agentId: "controlled-acp", queryBeforeUpgrade: true },
    { agentId: "codex", queryBeforeUpgrade: false },
])(
    "Given a $agentId conversation and retained reader=$queryBeforeUpgrade before an upgrade, When preparation and native history are requested, Then both use the upgraded Agent without restarting",
    {
        timeout: 120_000,
    },
    async ({ agentId, queryBeforeUpgrade }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-agent-refresh-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        const binDirectory = join(stateDirectory, "bin");
        const firstLauncher = join(stateDirectory, "controlled-acp-v1");
        const secondLauncher = join(stateDirectory, "controlled-acp-v2");
        const link = join(binDirectory, "controlled-acp");
        const peerLauncher = join(stateDirectory, "controlled-acp-peer");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory), mkdir(binDirectory)]);
        await writeFile(
            firstLauncher,
            launcherSource("1.0.0", new URL(`file://${fakeAgentPath}`).toString(), !queryBeforeUpgrade),
            {
                mode: 0o700,
            },
        );
        await writeFile(secondLauncher, launcherSource("1.1.0", new URL(`file://${fakeAgentPath}`).toString()), {
            mode: 0o700,
        });
        await writeFile(peerLauncher, launcherSource("1.0.0", new URL(`file://${fakeAgentPath}`).toString()), {
            mode: 0o700,
        });
        await symlink(firstLauncher, link);
        await symlink(peerLauncher, join(binDirectory, "controlled-acp-peer"));

        const catalogBodies: string[] = [];
        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    catalogBodies.push(Buffer.concat(chunks).toString("utf8"));
                    response.writeHead(204);
                    response.end();
                });
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
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
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

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const environment = {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
        };
        const inventory = await discoverLocalAgentInventory({
            dataDirectory: stateDirectory,
            defaultWorkspace: workspace,
            environment,
            signal: AbortSignal.timeout(60_000),
            specifications: specifications(agentId),
        });
        const agent = inventory.readyAgents().find((entry) => entry.id === agentId);
        if (agent === undefined || inventory.readyAgents().length !== 2) {
            await rm(stateDirectory, { force: true, recursive: true });
            throw new Error(`Controlled agent was not discovered: ${JSON.stringify(inventory.unavailable)}`);
        }
        const config: ReturnType<typeof createRuntimeConfig> = createRuntimeConfig(
            { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
            agentId === "codex"
                ? new RuntimeAgentDependencies(inventory.readyAgents())
                : new RuntimeAgentDependencies(inventory.readyAgents(), acpAdapters),
            new RuntimeLocalContext(stateDirectory, environment),
            null,
            createCatalogAgentResolver(
                (refreshSignal) =>
                    discoverLocalAgentInventory({
                        dataDirectory: stateDirectory,
                        defaultWorkspace: workspace,
                        environment,
                        signal: refreshSignal,
                        specifications: specifications(agentId),
                    }),
                () => config,
                publishAgentCatalog,
            ),
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            sendText(
                await socketReady.promise,
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: [],
                    agentId,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "session.prepare",
                    requestId: "prepare-before-agent-upgrade",
                    sessionId: "conversation-before-upgrade",
                }),
            );
            expect(await nextCommandOutcome(frames, "prepare-before-agent-upgrade")).toMatchObject({
                kind: "session.ready",
                ready: { agentVersion: "1.0.0" },
            });
            if (queryBeforeUpgrade) {
                sendText(
                    await socketReady.promise,
                    encodeNativeSessionCommand({
                        additionalDirectoryIds: [],
                        agentId,
                        bindingId: config.bindingId,
                        directoryId: "default",
                        kind: NATIVE_SESSION_REQUEST_KIND,
                        requestId: "browse-before-agent-upgrade",
                        sessionId: "native-browser",
                        action: "list",
                        cursor: null,
                    }),
                );
                expect(await nextCommandOutcome(frames, "browse-before-agent-upgrade")).toMatchObject({
                    kind: "session.operation.failed",
                    failure: { code: "native_session_unsupported" },
                });
            }
            const prepareRequestId = "prepare-after-agent-upgrade";
            const upgradedSessionId = "draft-agent-upgrade-new-conversation";
            await unlink(link);
            await symlink(secondLauncher, link);

            sendText(
                await socketReady.promise,
                encodeSessionPrepareCommand({
                    additionalDirectoryIds: [],
                    agentId,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "session.prepare",
                    requestId: prepareRequestId,
                    sessionId: upgradedSessionId,
                }),
            );
            const prepared = await nextCommandOutcome(frames, prepareRequestId);
            expect(prepared.kind === "session.operation.failed" ? prepared.failure.code : prepared.kind).toBe(
                "session.ready",
            );
            expect(prepared).toMatchObject({
                kind: "session.ready",
                ready: { agentVersion: "1.1.0", sessionId: upgradedSessionId },
            });

            const settingsRequestId = "settings-after-agent-upgrade";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    agentId,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: settingsRequestId,
                }),
            );
            const discovered = await nextCommandOutcome(frames, settingsRequestId);
            expect(discovered).toMatchObject({
                kind: AGENT_SETTINGS_DISCOVERED_KIND,
                discovered: { agentVersion: "1.1.0" },
            });

            sendText(
                await socketReady.promise,
                encodeNativeSessionCommand({
                    additionalDirectoryIds: [],
                    agentId,
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId: "browse-after-agent-upgrade",
                    sessionId: "native-browser",
                    action: "list",
                    cursor: null,
                }),
            );
            expect(await nextCommandOutcome(frames, "browse-after-agent-upgrade")).toMatchObject({
                kind: "native.session.result",
                result: { action: "list", capabilities: { listSessions: true }, entries: [], nextCursor: null },
            });

            if (agentId === "codex") {
                sendText(
                    await socketReady.promise,
                    encodeSessionPreviewHistoryPageLoad({
                        additionalDirectoryIds: [],
                        agentId,
                        bindingId: config.bindingId,
                        directoryId: "default",
                        kind: "session.preview-history.page.load",
                        requestId: "preview-after-agent-upgrade",
                        sessionId: "saved-thread",
                        eventLimit: 100,
                        cursor: null,
                    }),
                );
                const previewed = await nextCommandOutcome(frames, "preview-after-agent-upgrade");
                expect(previewed.kind).toBe("session.preview-history.page.loaded");
                if (previewed.kind === "session.preview-history.page.loaded") {
                    expect(previewed.preview.events.events.events).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                type: "acp",
                                payload: expect.objectContaining({
                                    sessionUpdate: "agent_message_chunk",
                                    content: { type: "text", text: "History from 1.1.0" },
                                }),
                            }),
                        ]),
                    );
                }
            }

            const republished = catalogBodies
                .map((body) => JSON.parse(body) as { agents: { agentVersion: string; id: string }[] })
                .filter((catalog) => catalog.agents.some((entry) => entry.agentVersion === "1.1.0"));
            expect(republished).toHaveLength(1);
            expect(republished[0]?.agents.map((entry) => entry.id).sort()).toEqual(
                [agentId, "controlled-acp-peer"].sort(),
            );
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime.catch(() => {});
            await rm(stateDirectory, { force: true, recursive: true });
            vi.useRealTimers();
        }
    },
);
