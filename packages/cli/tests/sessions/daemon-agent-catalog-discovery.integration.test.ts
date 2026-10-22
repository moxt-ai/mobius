import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    encodeAgentCatalogDiscoverCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { discoverLocalAgentInventory } from "../../src/agent/discovery/discover-local-agents.ts";
import type { LocalAgentSpecification } from "../../src/agent/specification/agent-specification.ts";
import { DirectAcpAgentDefinition } from "../../src/agent/specification/agent-specification.ts";
import { publishAgentCatalog } from "../../src/runtime/catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../src/runtime/catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, RuntimeLocalContext } from "../../src/runtime/config.ts";
import { runRuntime } from "../../src/runtime/run.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class FirstAgentSpecification extends DirectAcpAgentDefinition {
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

class LaterInstalledAgentSpecification extends DirectAcpAgentDefinition {
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

    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_catalog/daemon`);
    relayUrl.searchParams.set("token", "d".repeat(43));
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
        const socket = await socketReady.promise;
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
        const republished = catalogBodies
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
        for (const socket of relaySockets) {
            socket.destroy();
        }
        await runtime;
        await relay.close();
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
