import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
    AGENT_CATALOG_REFRESH_KIND,
    AGENT_CATALOG_REFRESHED_KIND,
    decodeAgentCatalogRefreshedEvent,
    decodeMessageKind,
    encodeAgentCatalogRefreshCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import { expect, it } from "vitest";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port, sendText } from "../../../tests/infra/websocket.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
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
async function readAgentCatalogRefresh(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== AGENT_CATALOG_REFRESHED_KIND) {
            continue;
        }
        const refreshed = decodeAgentCatalogRefreshedEvent(message);
        if (refreshed.requestId === requestId) {
            return refreshed;
        }
    }
}

import { CodexFixture } from "../infra/codex.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given a runtime refreshes its shell environment, When its private Agent cache is needed, Then catalog discovery retains the runtime state directory", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "REFRESH_REPLY");
    await using codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-catalog-state-"));
    const discardedStateDirectory = await mkdtemp(join(tmpdir(), "mobius-daemon-discarded-state-"));
    const workspace = join(stateDirectory, "workspace");
    const nativeStateDirectory = join(stateDirectory, "native");
    const executableDirectory = join(stateDirectory, "external");
    const codexPath = join(executableDirectory, "codex");
    await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(nativeStateDirectory, { recursive: true }),
        mkdir(executableDirectory, { recursive: true }),
    ]);

    const catalogBodies: string[] = [];
    const socketReady = Promise.withResolvers<Duplex>();
    const relaySockets = new Set<Duplex>();
    const relay = createServer((request, response) => {
        if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                catalogBodies.push(body);
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
    await codex.writeLauncher(codexPath);
    await listen(relay);

    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
    relayUrl.searchParams.set("token", "d".repeat(43));
    const contextEnvironment = {
        ...codex.environment,
        MOBIUS_CODEX_PATH: codexPath,
        PATH: executableDirectory,
    };
    const config = createDaemonConfig(
        {
            channelId: "channel_alpha",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [],
        [],
        new DaemonLocalContext(stateDirectory, contextEnvironment),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal, undefined, {
        resolveAgentCatalogEnvironment: async (signal: AbortSignal): Promise<Readonly<NodeJS.ProcessEnv>> => {
            signal.throwIfAborted();
            return {
                ...contextEnvironment,
                MOBIUS_STATE_DIRECTORY: discardedStateDirectory,
            };
        },
    });

    try {
        const socket = await socketReady.promise;
        const frames = new ClientFrames(socket);
        const requestId = "catalog-preserves-runtime-state";
        sendText(
            socket,
            encodeAgentCatalogRefreshCommand({
                kind: AGENT_CATALOG_REFRESH_KIND,
                requestId,
            }),
        );
        await readAgentCatalogRefresh(frames, requestId);

        expect(config.catalog.read().agents.map((agent) => agent.id)).toContain("codex");
        expect(catalogBodies.at(-1)).toContain('"id":"codex"');
    } finally {
        cancellation.abort();
        for (const socket of relaySockets) {
            socket.destroy();
        }
        relay.close();
        audit.close();
        await daemon;
        await Promise.all([
            rm(stateDirectory, { force: true, recursive: true }),
            rm(discardedStateDirectory, { force: true, recursive: true }),
        ]);
    }
});
