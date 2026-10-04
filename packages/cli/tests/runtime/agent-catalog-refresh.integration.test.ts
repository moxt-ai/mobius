import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    decodeAgentCatalogRefreshedEvent,
    decodeMessageKind,
    encodeAgentCatalogRefreshCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { discoverLocalAgentInventory } from "../../src/agent-catalog/discover-local-agents.ts";
import { publishAgentCatalog } from "../../src/agent-catalog/publish-agent-catalog.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { runDaemon } from "../../src/run-daemon.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));

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

interface PublishedCatalog {
    readonly agents: readonly { readonly id: string }[];
    readonly installableAgents: readonly { readonly id: string }[];
}

class RecordingCatalogRelay {
    readonly published: PublishedCatalog[] = [];
    readonly #catalogWaiters: Array<{
        readonly minimum: number;
        readonly resolve: (catalog: PublishedCatalog) => void;
    }> = [];
    readonly #server: Server;
    readonly #sockets = new Set<Duplex>();
    readonly #ready = Promise.withResolvers<Duplex>();
    #port = 0;

    readonly #catalogRejection: Readonly<{ code: string; message: string }> | null;

    private constructor(catalogRejection: Readonly<{ code: string; message: string }> | null) {
        this.#catalogRejection = catalogRejection;
        this.#server = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    const catalog = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PublishedCatalog;
                    this.published.push(catalog);
                    for (let index = this.#catalogWaiters.length - 1; index >= 0; index -= 1) {
                        const waiter = this.#catalogWaiters[index];
                        if (waiter !== undefined && this.published.length >= waiter.minimum) {
                            this.#catalogWaiters.splice(index, 1);
                            waiter.resolve(this.published[waiter.minimum - 1] ?? catalog);
                        }
                    }
                    if (this.#catalogRejection !== null) {
                        response.writeHead(400, { "content-type": "application/json" });
                        response.end(JSON.stringify({ error: this.#catalogRejection }));
                        return;
                    }
                    response.writeHead(204);
                    response.end();
                });
                return;
            }
            response.writeHead(404);
            response.end();
        });
        this.#server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => this.#sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        this.#server.on("upgrade", (request, socket) => {
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
            sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
            this.#ready.resolve(socket);
        });
    }

    static readonly open = async (
        catalogRejection: Readonly<{ code: string; message: string }> | null = null,
    ): Promise<RecordingCatalogRelay> => {
        const relay = new RecordingCatalogRelay(catalogRejection);
        await listen(relay.#server);
        relay.#port = port(relay.#server);
        return relay;
    };

    readonly socket = (): Promise<Duplex> => this.#ready.promise;

    readonly catalog = (minimum: number): Promise<PublishedCatalog> => {
        const published = this.published[minimum - 1];
        if (published !== undefined) {
            return Promise.resolve(published);
        }
        return new Promise((resolve) => this.#catalogWaiters.push({ minimum, resolve }));
    };

    readonly daemonUrl = (channelId: string): URL => {
        const url = new URL(`ws://127.0.0.1:${this.#port}${MOBIUS_API_PREFIX}/channels/${channelId}/daemon`);
        url.searchParams.set("token", "d".repeat(43));
        return url;
    };

    readonly close = async (): Promise<void> => {
        for (const socket of this.#sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    };
}

async function readRefreshed(frames: ClientFrames, requestId: string): Promise<void> {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== AGENT_CATALOG_REFRESHED_KIND) {
            continue;
        }
        if (decodeAgentCatalogRefreshedEvent(message).requestId === requestId) {
            return;
        }
    }
}

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

// A DirectAcpAgentDefinition exposes one real ACP executable, so the fake ACP agent can stand in
// for an installed Agent without any managed adapter or network access. The flags select exactly
// the capability set the DeepSeek Harness specification verifies.
async function writeFakeHarnessAgent(path: string): Promise<void> {
    await writeFile(
        path,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.5-rc.2\\n");
} else {
  process.argv.push(
    "--agent-name", "DeepSeek Harness",
    "--agent-version", "0.1.5-rc.2",
    "--no-load-session",
    "--http-mcp",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
    "--no-image-prompt",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    await chmod(path, 0o700);
}

describe("daemon Agent catalog refresh boundary", () => {
    it("Given the Relay rejects an Agent catalog with a typed reason, When the Runtime publishes it, Then the Runtime receives the rejection code and message", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-catalog-rejection-"));
        const workspace = join(stateDirectory, "workspace");
        await mkdir(workspace);
        const relay = await RecordingCatalogRelay.open({
            code: "invalid_agents",
            message: "The local Agent directory contains an unsupported descriptor",
        });
        const config = createDaemonConfig(
            {
                channelId: "catalog_rejection",
                defaultWorkspace: workspace,
                relayUrl: relay.daemonUrl("catalog_rejection"),
            },
            [],
            [],
            new DaemonLocalContext(stateDirectory),
        );

        try {
            await expect(publishAgentCatalog(config, new AbortController().signal)).rejects.toMatchObject({
                code: "agent_catalog_update_failed",
                diagnosticDetails: { relayErrorCode: "invalid_agents" },
                message:
                    "The Relay rejected the Agent catalog update (invalid_agents): The local Agent directory contains an unsupported descriptor",
            });
        } finally {
            await relay.close();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a ready Agent was verified before a refresh, When the refreshed environment no longer exposes that Agent, Then the Runtime keeps serving the verified Agent instead of dropping it", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-catalog-refresh-"));
        const workspace = join(stateDirectory, "workspace");
        const executableDirectory = join(stateDirectory, "external");
        await Promise.all([mkdir(workspace), mkdir(executableDirectory)]);
        await writeFakeHarnessAgent(join(executableDirectory, "dsh"));

        const relay = await RecordingCatalogRelay.open();
        const cancellation = new AbortController();
        // The paired Runtime verifies its Agents before it starts, so the initial catalog holds a
        // genuinely verified Agent. A refresh then observes an environment whose executable search
        // path lost that Agent, which is what a supervisor or login-shell environment change looks
        // like in practice.
        const pairedEnvironment: Readonly<NodeJS.ProcessEnv> = {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: executableDirectory,
        };
        const verifiedInventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment: pairedEnvironment,
            signal: cancellation.signal,
        });
        expect(verifiedInventory.readyAgents().map((agent) => agent.id)).toEqual(["deepseek-harness"]);

        let refreshEnvironment: Readonly<NodeJS.ProcessEnv> = pairedEnvironment;
        const config = createDaemonConfig(
            {
                channelId: "channel_refresh",
                defaultWorkspace: workspace,
                relayUrl: relay.daemonUrl("channel_refresh"),
            },
            verifiedInventory.readyAgents(),
            verifiedInventory.installable,
            new DaemonLocalContext(stateDirectory),
        );
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal, undefined, {
            resolveAgentCatalogEnvironment: async () => refreshEnvironment,
        });

        try {
            const frames = new ClientFrames(await relay.socket());
            const initial = await relay.catalog(1);
            expect(initial.agents.map((agent) => agent.id)).toEqual(["deepseek-harness"]);

            refreshEnvironment = { MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: join(stateDirectory, "empty") };
            const requestId = "refresh-with-degraded-environment";
            sendText(
                await relay.socket(),
                encodeAgentCatalogRefreshCommand({ kind: AGENT_CATALOG_REFRESH_KIND, requestId }),
            );
            await readRefreshed(frames, requestId);

            const refreshed = await relay.catalog(2);
            expect(refreshed.agents.map((agent) => agent.id)).toEqual(["deepseek-harness"]);
            expect(refreshed.installableAgents.map((agent) => agent.id)).not.toContain("deepseek-harness");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            await relay.close();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);

    it("Given a ready Agent was verified before a refresh, When the Agent executable is genuinely removed and not replaced by a managed install, Then the Runtime stops serving that Agent", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-catalog-uninstall-"));
        const workspace = join(stateDirectory, "workspace");
        const executableDirectory = join(stateDirectory, "external");
        await Promise.all([mkdir(workspace), mkdir(executableDirectory)]);
        const executablePath = join(executableDirectory, "dsh");
        await writeFakeHarnessAgent(executablePath);

        const relay = await RecordingCatalogRelay.open();
        const cancellation = new AbortController();
        const pairedEnvironment: Readonly<NodeJS.ProcessEnv> = {
            MOBIUS_STATE_DIRECTORY: stateDirectory,
            PATH: executableDirectory,
        };
        const verifiedInventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment: pairedEnvironment,
            signal: cancellation.signal,
        });
        expect(verifiedInventory.readyAgents().map((agent) => agent.id)).toEqual(["deepseek-harness"]);

        const config = createDaemonConfig(
            {
                channelId: "channel_uninstall",
                defaultWorkspace: workspace,
                relayUrl: relay.daemonUrl("channel_uninstall"),
            },
            verifiedInventory.readyAgents(),
            verifiedInventory.installable,
            new DaemonLocalContext(stateDirectory),
        );
        const audit = new AuditStore();
        const daemon = runDaemon(config, audit, cancellation.signal, undefined, {
            resolveAgentCatalogEnvironment: async () => pairedEnvironment,
        });

        try {
            const frames = new ClientFrames(await relay.socket());
            const initial = await relay.catalog(1);
            expect(initial.agents.map((agent) => agent.id)).toEqual(["deepseek-harness"]);

            await rm(executablePath, { force: true });
            const requestId = "refresh-after-uninstall";
            sendText(
                await relay.socket(),
                encodeAgentCatalogRefreshCommand({ kind: AGENT_CATALOG_REFRESH_KIND, requestId }),
            );
            await readRefreshed(frames, requestId);

            const refreshed = await relay.catalog(2);
            expect(refreshed.agents.map((agent) => agent.id)).not.toContain("deepseek-harness");
            expect(refreshed.installableAgents.map((agent) => agent.id)).toContain("deepseek-harness");
        } finally {
            cancellation.abort();
            await daemon;
            audit.close();
            await relay.close();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
