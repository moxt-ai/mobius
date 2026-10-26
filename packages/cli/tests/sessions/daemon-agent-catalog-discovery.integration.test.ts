import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_CATALOG_DISCOVERED_KIND,
    AGENT_CATALOG_DISCOVERY_FAILED_KIND,
    decodeAgentCatalogDiscoveredEvent,
    decodeAgentCatalogDiscoveryFailedEvent,
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeAgentCatalogDiscoverCommand,
    encodeSessionPrepareCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { discoverLocalAgentInventory } from "../../src/agent/discovery/discover-local-agents.ts";
import type { LocalAgentSpecification } from "../../src/agent/specification/agent-specification.ts";
import { DirectAcpAgentSpecification } from "../../src/agent/specification/agent-specification.ts";
import { publishAgentCatalog } from "../../src/runtime/catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../src/runtime/catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../src/runtime/config.ts";
import { runRuntime } from "../../src/runtime/run.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class FirstAgentSpecification extends DirectAcpAgentSpecification {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp";
    readonly id = "controlled-acp";
    readonly label = "Controlled ACP";
    override readonly maximumTestedAgentVersion = this.adapterVersion;
    override readonly minimumSupportedAgentVersion = this.adapterVersion;

    constructor() {
        super("MOBIUS_TEST_CATALOG_AGENT_PATH", []);
    }
}

class LaterInstalledAgentSpecification extends DirectAcpAgentSpecification {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp-later";
    readonly id = "controlled-acp-later";
    readonly label = "Controlled ACP Later";
    override readonly maximumTestedAgentVersion = this.adapterVersion;
    override readonly minimumSupportedAgentVersion = this.adapterVersion;

    constructor() {
        super("MOBIUS_TEST_CATALOG_LATER_AGENT_PATH", []);
    }
}

function specifications(): readonly LocalAgentSpecification[] {
    return [new FirstAgentSpecification(), new LaterInstalledAgentSpecification()];
}

function launcherSource(version: string): string {
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
await import(${JSON.stringify(`file://${fakeAgentPath}`)});
`;
}

type DiscoveryOutcome =
    | {
          readonly kind: typeof AGENT_CATALOG_DISCOVERED_KIND;
          readonly event: ReturnType<typeof decodeAgentCatalogDiscoveredEvent>;
      }
    | {
          readonly kind: typeof AGENT_CATALOG_DISCOVERY_FAILED_KIND;
          readonly failure: ReturnType<typeof decodeAgentCatalogDiscoveryFailedEvent>;
      };

async function nextCatalogOutcome(frames: ClientFrames, requestId: string): Promise<DiscoveryOutcome> {
    for (;;) {
        const message = await frames.next();
        const kind = decodeMessageKind(message);
        if (kind === AGENT_CATALOG_DISCOVERY_FAILED_KIND) {
            const failure = decodeAgentCatalogDiscoveryFailedEvent(message);
            if (failure.requestId === requestId) {
                return { kind, failure };
            }
        }
        if (kind === AGENT_CATALOG_DISCOVERED_KIND) {
            const event = decodeAgentCatalogDiscoveredEvent(message);
            if (event.requestId === requestId) {
                return { kind, event };
            }
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                throw new Error(`Unexpected session.ready while waiting for ${requestId}`);
            }
        }
    }
}

async function nextSessionReady(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        const kind = decodeMessageKind(message);
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                return ready;
            }
        }
        if (kind === "session.operation.failed") {
            const failed = decodeSessionOperationFailedEvent(message);
            if (failed.requestId === requestId) {
                throw new Error(`session.prepare failed: ${failed.code} ${failed.message}`);
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

interface CatalogRelay {
    /** Recorded catalog publications, in arrival order. */
    readonly catalogBodies: string[];
    /** Queue a gate for the next catalog PUT: the test resolves it to accept or rejects to fail. */
    readonly gateNextPut: () => PromiseWithResolvers<void>;
    /** Resolves once the given number of catalog PUTs has arrived. */
    readonly waitForCatalogPutCountAtLeast: (n: number) => Promise<void>;
    readonly close: () => Promise<void>;
    readonly socket: Promise<Duplex>;
    readonly url: (channelId: string) => URL;
}

/** Accepts the daemon WebSocket and records every catalog publication, like the real Relay would. */
async function createCatalogRelay(): Promise<CatalogRelay> {
    const catalogBodies: string[] = [];
    const catalogPutControl: Array<PromiseWithResolvers<void>> = [];
    const putArrivals: Array<{ readonly n: number; readonly resolve: () => void }> = [];
    let putCount = 0;
    const socketReady = Promise.withResolvers<Duplex>();
    const relaySockets = new Set<Duplex>();
    const relay = createServer((request, response) => {
        if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                const gated = catalogPutControl.shift();
                catalogBodies.push(body);
                putCount += 1;
                for (let index = putArrivals.length - 1; index >= 0; index -= 1) {
                    const arrival = putArrivals[index];
                    if (arrival !== undefined && arrival.n <= putCount) {
                        putArrivals.splice(index, 1);
                        arrival.resolve();
                    }
                }
                if (gated === undefined) {
                    response.writeHead(204);
                    response.end();
                    return;
                }
                // Hold this publication open until the test releases it, then accept or reject.
                gated.promise.then(
                    () => {
                        response.writeHead(204);
                        response.end();
                    },
                    () => {
                        response.writeHead(503);
                        response.end();
                    },
                );
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
    return {
        catalogBodies,
        close: async () => {
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        },
        gateNextPut: () => {
            const gate = Promise.withResolvers<void>();
            catalogPutControl.push(gate);
            return gate;
        },
        socket: socketReady.promise,
        url: (channelId: string) => {
            const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/${channelId}/daemon`);
            relayUrl.searchParams.set("token", "d".repeat(43));
            return relayUrl;
        },
        waitForCatalogPutCountAtLeast: (n: number) => {
            if (putCount >= n) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
                putArrivals.push({ n, resolve });
            });
        },
    };
}

test("Given the daemon started before an Agent was installed, When the Relay requests an Agent catalog discovery, Then the daemon re-discovers the inventory, republishes the catalog with the new Agent, and answers with it", {
    timeout: 120_000,
}, async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-agent-catalog-discovery-"));
    const workspace = join(stateDirectory, "workspace");
    const binDirectory = join(stateDirectory, "bin");
    const laterLauncher = join(stateDirectory, "controlled-acp-later-v1");
    await Promise.all([
        mkdir(workspace),
        mkdir(binDirectory),
        writeFile(laterLauncher, launcherSource("1.0.0"), { mode: 0o700 }),
    ]);
    const firstLauncher = join(binDirectory, "controlled-acp");
    await writeFile(firstLauncher, launcherSource("1.0.0"), { mode: 0o700 });
    await chmod(firstLauncher, 0o700);

    const relay = await createCatalogRelay();

    const relayUrl = relay.url("channel_catalog");
    const environment = {
        MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "native"),
        PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
    };
    const discover = (signal: AbortSignal) =>
        discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment,
            signal,
            specifications: specifications(),
        });
    const inventory = await discover(AbortSignal.timeout(60_000));
    if (inventory.readyAgents().length !== 1) {
        throw new Error(`Expected exactly one ready Agent, got: ${JSON.stringify(inventory.discoveries)}`);
    }
    const config: ReturnType<typeof createRuntimeConfig> = createRuntimeConfig(
        { channelId: "channel_catalog", defaultWorkspace: workspace, relayUrl },
        inventory.readyAgents(),
        new RuntimeLocalContext(stateDirectory, environment),
        null,
        createCatalogAgentResolver(discover, () => config, publishAgentCatalog),
        (refreshSignal: AbortSignal) => discover(refreshSignal).then((result) => result.readyAgents()),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);

    try {
        const socket = await relay.socket;
        const frames = new ClientFrames(socket);

        // Install the second Agent after the daemon started.
        await symlink(laterLauncher, join(binDirectory, "controlled-acp-later"));

        const requestId = "catalog-discovery-after-install";
        sendText(socket, encodeAgentCatalogDiscoverCommand({ kind: "agent.catalog.discover", requestId }));
        const outcome = await nextCatalogOutcome(frames, requestId);
        expect(outcome.kind === AGENT_CATALOG_DISCOVERY_FAILED_KIND ? outcome.failure.code : outcome.kind).toBe(
            AGENT_CATALOG_DISCOVERED_KIND,
        );
        expect(
            outcome.kind === AGENT_CATALOG_DISCOVERED_KIND ? outcome.event.agents.map((a) => a.id).sort() : [],
        ).toEqual(["controlled-acp", "controlled-acp-later"]);

        // The daemon republished its catalog so Relay-served reads stop serving the boot set.
        const republished = relay.catalogBodies
            .map((body) => JSON.parse(body) as { agents: { id: string }[] })
            .filter((catalog) => catalog.agents.some((entry) => entry.id === "controlled-acp-later"));
        expect(republished).toHaveLength(1);
        expect(
            config.catalog
                .read()
                .agents.map((agent) => agent.id)
                .sort(),
        ).toEqual(["controlled-acp", "controlled-acp-later"]);
    } finally {
        cancellation.abort();
        await runtime;
        await relay.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});

test("Given a full catalog discovery is publishing, When the per-Agent resolver commits a concurrent upgrade and the full publication then fails, Then the rollback keeps the resolver's committed swap", {
    timeout: 120_000,
}, async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-agent-catalog-race-"));
    const workspace = join(stateDirectory, "workspace");
    const binDirectory = join(stateDirectory, "bin");
    const firstLauncher = join(stateDirectory, "controlled-acp-v1");
    const secondLauncher = join(stateDirectory, "controlled-acp-v2");
    await Promise.all([
        mkdir(workspace),
        mkdir(binDirectory),
        writeFile(firstLauncher, launcherSource("1.0.0"), { mode: 0o700 }),
        writeFile(secondLauncher, launcherSource("1.1.0"), { mode: 0o700 }),
    ]);
    const link = join(binDirectory, "controlled-acp");
    await symlink(firstLauncher, link);

    const relay = await createCatalogRelay();
    const relayUrl = relay.url("channel_catalog_race");
    const environment = {
        MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "native"),
        PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
    };
    const discover = (signal: AbortSignal) =>
        discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment,
            signal,
            specifications: specifications(),
        });
    const inventory = await discover(AbortSignal.timeout(60_000));
    if (inventory.readyAgents().length !== 1) {
        throw new Error(`Expected exactly one ready Agent, got: ${JSON.stringify(inventory.discoveries)}`);
    }
    const config: ReturnType<typeof createRuntimeConfig> = createRuntimeConfig(
        { channelId: "channel_catalog_race", defaultWorkspace: workspace, relayUrl },
        inventory.readyAgents(),
        new RuntimeLocalContext(stateDirectory, environment),
        null,
        createCatalogAgentResolver(discover, () => config, publishAgentCatalog),
        (refreshSignal: AbortSignal) => discover(refreshSignal).then((result) => result.readyAgents()),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);

    try {
        const socket = await relay.socket;
        const frames = new ClientFrames(socket);
        await relay.waitForCatalogPutCountAtLeast(1); // the boot-time publication

        // Hold the full discovery's publication open, then start the discovery.
        const discoveryGate = relay.gateNextPut();
        const discoveryRequestId = "catalog-discovery-racing-resolver";
        sendText(
            socket,
            encodeAgentCatalogDiscoverCommand({ kind: "agent.catalog.discover", requestId: discoveryRequestId }),
        );
        await relay.waitForCatalogPutCountAtLeast(2);

        // Upgrade the Agent's binary and start a session: the resolver's swap queues behind the
        // full discovery's critical section instead of committing under its open publication.
        await unlink(link);
        await symlink(secondLauncher, link);
        const prepareRequestId = "prepare-racing-catalog-discovery";
        sendText(
            socket,
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "controlled-acp",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: prepareRequestId,
                sessionId: "session-catalog-discovery-race",
            }),
        );

        // The full discovery's publication fails; its rollback restores the snapshot it read.
        discoveryGate.reject(new Error("catalog publication rejected"));
        const outcome = await nextCatalogOutcome(frames, discoveryRequestId);
        expect(outcome.kind).toBe(AGENT_CATALOG_DISCOVERY_FAILED_KIND);

        // The queued resolver swap then commits and publishes: the upgraded Agent stays in the
        // catalog even though the full discovery rolled back. Without the shared lock the swap
        // would have committed under the open publication and the rollback would revert it.
        const ready = await nextSessionReady(frames, prepareRequestId);
        expect(ready.agentVersion).toBe("1.1.0");
        expect(
            config.catalog
                .read()
                .agents.map((agent) => agent.id)
                .sort(),
        ).toEqual(["controlled-acp"]);
        const lastPublished = JSON.parse(relay.catalogBodies[relay.catalogBodies.length - 1] ?? "{}") as {
            agents: { agentVersion: string; id: string }[];
        };
        expect(lastPublished.agents.map((entry) => ({ agentVersion: entry.agentVersion, id: entry.id }))).toEqual([
            { agentVersion: "1.1.0", id: "controlled-acp" },
        ]);
        // The committed memory and the last Relay publication describe the same Agents: the
        // failed discovery's rollback did not silently diverge them.
        const catalogedVersion = config.catalog.read().agents[0]?.agentVersion;
        expect(catalogedVersion).toBe("1.1.0");
    } finally {
        cancellation.abort();
        await runtime;
        await relay.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});

test("Given a full catalog discovery has published, When a queued per-Agent resolver swap commits before the discovery answers, Then the reply still describes the snapshot the discovery published", {
    timeout: 120_000,
}, async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-agent-catalog-reply-"));
    const workspace = join(stateDirectory, "workspace");
    const binDirectory = join(stateDirectory, "bin");
    const firstLauncher = join(stateDirectory, "controlled-acp-v1");
    const secondLauncher = join(stateDirectory, "controlled-acp-v2");
    await Promise.all([
        mkdir(workspace),
        mkdir(binDirectory),
        writeFile(firstLauncher, launcherSource("1.0.0"), { mode: 0o700 }),
        writeFile(secondLauncher, launcherSource("1.1.0"), { mode: 0o700 }),
    ]);
    const link = join(binDirectory, "controlled-acp");
    await symlink(firstLauncher, link);

    const relay = await createCatalogRelay();
    const relayUrl = relay.url("channel_catalog_reply");
    const environment = {
        MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "native"),
        PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
    };
    const discover = (signal: AbortSignal) =>
        discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment,
            signal,
            specifications: specifications(),
        });
    const inventory = await discover(AbortSignal.timeout(60_000));
    if (inventory.readyAgents().length !== 1) {
        throw new Error(`Expected exactly one ready Agent, got: ${JSON.stringify(inventory.discoveries)}`);
    }
    const resolverDiscovered = Promise.withResolvers<void>();
    const config: ReturnType<typeof createRuntimeConfig> = createRuntimeConfig(
        { channelId: "channel_catalog_reply", defaultWorkspace: workspace, relayUrl },
        inventory.readyAgents(),
        new RuntimeLocalContext(stateDirectory, environment),
        null,
        createCatalogAgentResolver(
            async (signal) => {
                const result = await discover(signal);
                resolverDiscovered.resolve();
                return result;
            },
            () => config,
            publishAgentCatalog,
        ),
        (refreshSignal: AbortSignal) => discover(refreshSignal).then((result) => result.readyAgents()),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);

    try {
        const socket = await relay.socket;
        const frames = new ClientFrames(socket);
        await relay.waitForCatalogPutCountAtLeast(1); // the boot-time publication

        // Hold the full discovery's publication open, then start the discovery.
        const discoveryGate = relay.gateNextPut();
        const discoveryRequestId = "catalog-discovery-reply-snapshot";
        sendText(
            socket,
            encodeAgentCatalogDiscoverCommand({ kind: "agent.catalog.discover", requestId: discoveryRequestId }),
        );
        await relay.waitForCatalogPutCountAtLeast(2);

        // Upgrade the Agent's binary and start a session: the resolver re-discovers the Agent
        // and queues its swap behind the full discovery's critical section.
        await unlink(link);
        await symlink(secondLauncher, link);
        const prepareRequestId = "prepare-discovery-reply-snapshot";
        sendText(
            socket,
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "controlled-acp",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: prepareRequestId,
                sessionId: "session-catalog-discovery-reply",
            }),
        );
        // Complete the resolver's probe before releasing the publication's HTTP response.
        // Its catalog replacement queues while that response travels back to the daemon.
        await resolverDiscovered.promise;

        // The full discovery's publication succeeds and the lock releases; the queued resolver
        // swap commits its newer snapshot before the discovery handler resumes to answer.
        discoveryGate.resolve();
        const outcome = await nextCatalogOutcome(frames, discoveryRequestId);
        expect(outcome.kind).toBe(AGENT_CATALOG_DISCOVERED_KIND);
        if (outcome.kind !== AGENT_CATALOG_DISCOVERED_KIND) {
            throw new Error("unreachable");
        }
        // The reply describes the snapshot the discovery itself published (the pre-upgrade
        // Agent), not the newer snapshot the resolver committed after the lock released.
        expect(outcome.event.agents.map((agent) => ({ agentVersion: agent.agentVersion, id: agent.id }))).toEqual([
            { agentVersion: "1.0.0", id: "controlled-acp" },
        ]);

        // The queued resolver swap still commits on top: the session serves the upgrade and the
        // final catalog reflects it.
        const ready = await nextSessionReady(frames, prepareRequestId);
        expect(ready.agentVersion).toBe("1.1.0");
        expect(config.catalog.read().agents[0]?.agentVersion).toBe("1.1.0");
    } finally {
        cancellation.abort();
        await runtime;
        await relay.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
