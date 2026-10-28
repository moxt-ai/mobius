import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeMessageKind,
    encodeAgentSettingsDiscoverCommand,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port, sendText } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const recorderPath = fileURLToPath(new URL("./fixtures/acp-environment-recorder.ts", import.meta.url));

/** Reads the daemon's unmasked text frames until one of the given kind arrives. */
function nextMessageOfKind(socket: Duplex, kind: string): Promise<void> {
    return new Promise((resolve_) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.byteLength >= 6) {
                const encodedLength = buffered.readUInt8(1) & 0x7f;
                const headerLength = encodedLength === 126 ? 4 : encodedLength === 127 ? 10 : 2;
                const payloadLength =
                    encodedLength === 126
                        ? buffered.readUInt16BE(2)
                        : encodedLength === 127
                          ? Number(buffered.readBigUInt64BE(2))
                          : encodedLength;
                const frameLength = headerLength + 4 + payloadLength;
                if (buffered.byteLength < frameLength) {
                    return;
                }
                const mask = buffered.subarray(headerLength, headerLength + 4);
                const payload = Buffer.from(buffered.subarray(headerLength + 4, frameLength));
                const opcode = buffered.readUInt8(0) & 0x0f;
                buffered = buffered.subarray(frameLength);
                for (let index = 0; index < payload.byteLength; index += 1) {
                    payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
                }
                if (opcode === 1 && decodeMessageKind(payload.toString("utf8")) === kind) {
                    socket.off("data", onData);
                    resolve_();
                    return;
                }
            }
        };
        socket.on("data", onData);
    });
}

/** Starts a daemon whose Runtime keeps its data in an installation directory, launches its Agent, and reads what the Agent inherited. */
async function inheritedStateDirectory(daemonEnvironment: NodeJS.ProcessEnv): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), "mobius-agent-environment-"));
    const installationData = join(
        directory,
        "root",
        "versions",
        "0.0.0",
        "installations",
        "dev.mobius.cli",
        "min_test",
    );
    const workspace = join(directory, "workspace");
    const record = join(directory, "agent-environment.json");
    await Promise.all([mkdir(installationData, { recursive: true }), mkdir(workspace)]);

    const socketReady = Promise.withResolvers<Duplex>();
    const sockets = new Set<Duplex>();
    const relay = createServer((request, response) => {
        request.resume();
        response.writeHead(request.method === "PUT" ? 204 : 404);
        response.end();
    });
    relay.on("upgrade", (request, socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        const accept = createHash("sha1")
            .update(`${request.headers["sec-websocket-key"] ?? ""}${websocketGuid}`)
            .digest("base64");
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        sendText(socket, JSON.stringify({ kind: "runtime.liveness.ready" }));
        socketReady.resolve(socket);
    });
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MOBIUS_API_PREFIX}/channels/channel_environment/daemon`);
    relayUrl.searchParams.set("token", "d".repeat(43));

    const agent = new AcpAgentDefinition(
        "controlled-acp",
        "Controlled ACP",
        process.execPath,
        (options) =>
            new ControlledAcpConnection(
                {
                    id: "controlled-acp",
                    adapterPath: process.execPath,
                    arguments: [recorderPath],
                    environment: options.environment,
                },
                options,
            ),
        {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "native"),
            MOBIUS_TEST_ENVIRONMENT_RECORD: record,
        },
    );
    const config = createControlledRuntimeConfig(
        { channelId: "channel_environment", defaultWorkspace: workspace, relayUrl },
        [agent],
        // As the worker does: the Runtime's local data is this installation's directory.
        new RuntimeLocalContext(installationData, daemonEnvironment),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await socketReady.promise;
        const discovered = nextMessageOfKind(socket, AGENT_SETTINGS_DISCOVERED_KIND);
        sendText(
            socket,
            encodeAgentSettingsDiscoverCommand({
                agentId: agent.id,
                kind: AGENT_SETTINGS_DISCOVER_KIND,
                requestId: "environment-discovery",
            }),
        );
        await discovered;
        const recorded: unknown = JSON.parse(await readFile(record, "utf8"));
        return recorded;
    } finally {
        cancellation.abort();
        for (const socket of sockets) {
            socket.destroy();
        }
        relay.close();
        await runtime;
        await rm(directory, { force: true, recursive: true });
    }
}

test("Given a daemon started with a custom state root, When it launches an Agent, Then the Agent inherits that root rather than the Runtime's installation data", {
    timeout: 60_000,
}, async () => {
    const root = join(tmpdir(), "mobius-custom-root");
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: root };

    expect(await inheritedStateDirectory(environment)).toEqual({ stateDirectory: root });
});

test("Given a daemon started with the default state root, When it launches an Agent, Then the Agent's environment leaves the root unset so Mobius there uses the same default", {
    timeout: 60_000,
}, async () => {
    const environment = { ...process.env };
    delete environment["MOBIUS_STATE_DIRECTORY"];

    expect(await inheritedStateDirectory(environment)).toEqual({ stateDirectory: null });
});
