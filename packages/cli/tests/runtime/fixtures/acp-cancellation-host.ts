import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { agent as acpAgent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
    AGENT_SETTINGS_DISCOVERED_KIND,
    encodeAgentSettingsDiscoverCommand,
    encodeRuntimeLivenessReadyEvent,
    RUNTIME_HEARTBEAT_ACK_MESSAGE,
    RUNTIME_HEARTBEAT_MESSAGE,
    RUNTIME_LIVENESS_READY_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { WebSocketServer } from "ws";
import { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import type { InProcessAcpEndpoint } from "../../../src/engine/acp/agent/in-process-endpoint.ts";
import { RuntimeLocalContext } from "../../../src/engine/runtime/config.ts";
import { MobiusRuntimeEngine } from "../../../src/exports/engine.ts";
import { ControlledEndpointConnection } from "../../support/agents/controlled-endpoint-connection.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../../support/controlled-runtime-config.ts";

// External Agent failure modes: cancellation before its initialization promise is
// observed, cancellation while initialization is pending, and ordinary startup failure.
// A process-level fatal handler reproduces the integrated Moxt host's exit policy.
process.on("unhandledRejection", (error: unknown) => {
    process.stderr.write(`unhandled_rejection: ${String(error)}\n`);
    process.exit(91);
});

const [directory, cancellation] = process.argv.slice(2);
if (directory === undefined || cancellation === undefined) {
    throw new Error("Missing fixture arguments");
}
const controller = new AbortController();
const reason = new Error("The Runtime owner cancelled initialization");
let cancelled = false;
let endpointClosed = false;
const http = createServer((request, response) => {
    request.resume();
    response.writeHead(request.method === "PUT" ? 204 : 404).end();
});
const relay = new WebSocketServer({ server: http });
const settings = Promise.withResolvers<void>();
const app = acpAgent({ name: "cancellation-peer" })
    .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        agentInfo: { name: "cancellation-peer", version: "1.0.0" },
        authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "settings-session", configOptions: [] }));

const endpoint = (): InProcessAcpEndpoint => {
    const initialized = Promise.withResolvers<void>();
    const terminated = Promise.withResolvers<{ readonly kind: "closed" }>();
    let pending = false;
    return {
        app: () => app,
        terminated: terminated.promise,
        initialize: () => {
            if (cancelled) {
                return Promise.resolve();
            }
            pending = true;
            cancelled = true;
            process.stdout.write("external-agent-initializing\n");
            if (cancellation === "before-observation") {
                controller.abort(reason);
            } else {
                setImmediate(() => controller.abort(reason));
            }
            return initialized.promise;
        },
        close: async () => {
            endpointClosed = true;
            if (pending) {
                initialized.reject(new Error("ACP connection closed"));
            }
            terminated.resolve({ kind: "closed" });
        },
    };
};

relay.on("connection", (socket) => {
    socket.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
    socket.on("message", (encoded) => {
        const text = encoded.toString();
        if (text === RUNTIME_HEARTBEAT_MESSAGE) {
            socket.send(RUNTIME_HEARTBEAT_ACK_MESSAGE);
        } else if (JSON.parse(text).kind === AGENT_SETTINGS_DISCOVERED_KIND) {
            settings.resolve();
        }
    });
    socket.send(
        encodeAgentSettingsDiscoverCommand({
            kind: "agent.settings.discover",
            agentId: "cancellation-peer",
            requestId: cancelled ? "healthy-settings" : "cancelled-settings",
        }),
    );
});

await mkdir(join(directory, "workspace"), { recursive: true });
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (address === null || typeof address === "string") {
    throw new Error("Relay did not bind");
}
const config = createRuntimeConfig(
    {
        channelId: "cancellation-test",
        defaultWorkspace: join(directory, "workspace"),
        relayUrl: new URL(`ws://127.0.0.1:${address.port}/daemon?token=${"r".repeat(43)}`),
    },
    [
        new AcpAgentDefinition(
            "cancellation-peer",
            "Cancellation peer",
            process.execPath,
            (options) => new ControlledEndpointConnection(endpoint(), options.client),
        ),
    ],
    new RuntimeLocalContext(directory, { PATH: process.env["PATH"] }),
);
try {
    await new MobiusRuntimeEngine(config).run(controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!endpointClosed) {
        throw new Error("The cancelled endpoint was not closed");
    }
    process.stdout.write("cancelled-request-settled\n");
    const healthy = new AbortController();
    const runtime = new MobiusRuntimeEngine(config).run(healthy.signal);
    try {
        await settings.promise;
        process.stdout.write("subsequent-settings-succeeded\n");
    } finally {
        healthy.abort();
        await runtime;
    }
} finally {
    for (const client of relay.clients) {
        client.terminate();
    }
    await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
}
