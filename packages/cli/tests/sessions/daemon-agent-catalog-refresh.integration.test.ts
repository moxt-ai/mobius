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
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionPrepareCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import type { LocalAgentSpecification } from "../../src/agent-catalog/agent-specification.ts";
import { DirectAcpAgentDefinition } from "../../src/agent-catalog/agent-specification.ts";
import { discoverLocalAgentInventory } from "../../src/agent-catalog/discover-local-agents.ts";
import { publishAgentCatalog } from "../../src/agent-catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../src/agent-catalog/resolve-catalog-agent.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { runDaemon } from "../../src/run-daemon.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class RefreshableAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp";
    readonly id = "controlled-acp";
    readonly label = "Controlled ACP";
    override readonly maximumTestedAgentVersion = this.adapterVersion;
    override readonly minimumSupportedAgentVersion = this.adapterVersion;

    constructor() {
        super("MOBIUS_TEST_REFRESHABLE_AGENT_PATH", [], ["agents", "controlled-acp", "bin.js"]);
    }
}

// A second ready Agent whose executable never changes, so a refresh of the upgraded Agent must
// keep exactly one catalog entry for it.
class UnchangedPeerAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp-peer";
    readonly id = "controlled-acp-peer";
    readonly label = "Controlled ACP Peer";

    constructor() {
        super("MOBIUS_TEST_PEER_PATH", ["--profile", "acp"], ["agents", "peer", "bin.js"]);
    }
}

function specifications(): readonly LocalAgentSpecification[] {
    return [new RefreshableAgentSpecification(), new UnchangedPeerAgentSpecification()];
}

function launcherSource(version: string, peerUrl: string): string {
    return `#!${process.execPath}
const version = ${JSON.stringify(version)};
if (process.argv.includes("--version")) {
    process.stdout.write(version + "\\n");
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
await import(${JSON.stringify(peerUrl)});
`;
}

type PrepareOutcome =
    | {
          readonly kind: "session.operation.failed";
          readonly failure: ReturnType<typeof decodeSessionOperationFailedEvent>;
      }
    | { readonly kind: "session.ready"; readonly ready: ReturnType<typeof decodeSessionReadyEvent> }
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

test("Given the local Agent executable is upgraded after the daemon started, When a new conversation is prepared and its settings are discovered, Then both succeed with the upgraded Agent and the catalog is republished without duplicating the unchanged Agent", {
    timeout: 120_000,
}, async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-agent-refresh-"));
    const workspace = join(stateDirectory, "workspace");
    const nativeStateDirectory = join(stateDirectory, "native");
    const binDirectory = join(stateDirectory, "bin");
    const firstLauncher = join(stateDirectory, "controlled-acp-v1");
    const secondLauncher = join(stateDirectory, "controlled-acp-v2");
    const link = join(binDirectory, "controlled-acp");
    const peerLauncher = join(stateDirectory, "controlled-acp-peer");
    await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory), mkdir(binDirectory)]);
    await writeFile(firstLauncher, launcherSource("1.0.0", new URL(`file://${fakeAgentPath}`).toString()), {
        mode: 0o700,
    });
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
        defaultWorkspace: workspace,
        environment,
        signal: AbortSignal.timeout(60_000),
        specifications: specifications(),
    });
    const agent = inventory.readyAgents().find((entry) => entry.id === "controlled-acp");
    if (agent === undefined || inventory.readyAgents().length !== 2) {
        await rm(stateDirectory, { force: true, recursive: true });
        throw new Error(`Controlled agent was not discovered: ${JSON.stringify(inventory.unavailable)}`);
    }
    const config: ReturnType<typeof createDaemonConfig> = createDaemonConfig(
        { channelId: "channel_alpha", defaultWorkspace: workspace, relayUrl },
        inventory.readyAgents(),
        [],
        new DaemonLocalContext(stateDirectory, environment),
        null,
        createCatalogAgentResolver(
            (refreshSignal) =>
                discoverLocalAgentInventory({
                    defaultWorkspace: workspace,
                    environment,
                    signal: refreshSignal,
                    specifications: specifications(),
                }),
            () => config,
            publishAgentCatalog,
        ),
    );
    const cancellation = new AbortController();
    const daemon = runDaemon(config, cancellation.signal);

    try {
        const frames = new ClientFrames(await socketReady.promise);
        const prepareRequestId = "prepare-after-agent-upgrade";
        const upgradedSessionId = "draft-agent-upgrade-new-conversation";
        await unlink(link);
        await symlink(secondLauncher, link);

        sendText(
            await socketReady.promise,
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "controlled-acp",
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
                agentId: "controlled-acp",
                kind: AGENT_SETTINGS_DISCOVER_KIND,
                requestId: settingsRequestId,
            }),
        );
        const discovered = await nextCommandOutcome(frames, settingsRequestId);
        expect(discovered).toMatchObject({
            kind: AGENT_SETTINGS_DISCOVERED_KIND,
            discovered: { agentVersion: "1.1.0" },
        });

        const republished = catalogBodies
            .map((body) => JSON.parse(body) as { agents: { agentVersion: string; id: string }[] })
            .filter((catalog) => catalog.agents.some((entry) => entry.agentVersion === "1.1.0"));
        expect(republished).toHaveLength(1);
        expect(republished[0]?.agents.map((entry) => entry.id).sort()).toEqual([
            "controlled-acp",
            "controlled-acp-peer",
        ]);
    } finally {
        cancellation.abort();
        for (const socket of relaySockets) {
            socket.destroy();
        }
        relay.close();
        await daemon.catch(() => {});
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
