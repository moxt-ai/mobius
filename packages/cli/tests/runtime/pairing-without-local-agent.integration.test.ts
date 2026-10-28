import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";

interface PairingRelay {
    readonly claims: Array<Readonly<Record<string, unknown>>>;
    readonly dispose: () => Promise<void>;
    readonly origin: string;
}

/**
 * Accepts the pairing redemption and records the Agent directory the machine advertised. Only the
 * Agent inventory is under test; the redemption response is the Relay's own contract.
 */
async function createPairingRelay(): Promise<PairingRelay> {
    const claims: Array<Readonly<Record<string, unknown>>> = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            claims.push(JSON.parse(body) as Readonly<Record<string, unknown>>);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    appId: "app_unattended",
                    channelId: "unattended-channel",
                    runtimeCredential: "u".repeat(32),
                    runtimeId: "unattended-runtime",
                }),
            );
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await listen(server);
    return {
        claims,
        dispose: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        },
        origin: `http://127.0.0.1:${port(server)}`,
    };
}

// Empty overrides short-circuit discovery for every supported Agent, so no machine installation
// can satisfy the pairing. This keeps the scenario independent of what the developer has on PATH.
function agentlessEnvironment(stateDirectory: string): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({
        MOBIUS_CLAUDE_PATH: "",
        MOBIUS_CODEX_PATH: "",
        MOBIUS_PI_PATH: "",
        MOBIUS_STATE_DIRECTORY: stateDirectory,
        PATH: "",
    });
}

describe("pairing a machine without a local Agent", () => {
    it("Given no supported Agent is discoverable, When the machine redeems its pairing, Then it pairs and advertises an empty Agent directory", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-unattended-pairing-"));
        const relay = await createPairingRelay();

        try {
            const { MobiusRuntimeEngine } = await import("../../src/exports/engine.ts");
            const engine = new MobiusRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: agentlessEnvironment(stateDirectory),
            });

            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    pairingId: "unattended-pairing",
                    relayOrigin: relay.origin,
                },
                AbortSignal.timeout(20_000),
            );

            expect(
                await engine.getConnectionManager().read(paired.connectionId, AbortSignal.timeout(5_000)),
            ).toMatchObject({
                appId: "app_unattended",
                channelId: "unattended-channel",
                runtimeId: "unattended-runtime",
            });
            expect(relay.claims).toHaveLength(1);
            expect(relay.claims[0]).toMatchObject({
                agents: [],
                pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
            });
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an unattended machine is already paired, When another Engine reads its saved connection, Then pairing is retained without redeeming again", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-unattended-resume-"));
        const relay = await createPairingRelay();
        const environment = agentlessEnvironment(stateDirectory);

        try {
            const { MobiusRuntimeEngine } = await import("../../src/exports/engine.ts");
            const engine = new MobiusRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: environment,
            });
            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    pairingId: "unattended-pairing",
                    relayOrigin: relay.origin,
                },
                AbortSignal.timeout(20_000),
            );

            const resumed = await new MobiusRuntimeEngine({
                engineDataDir: stateDirectory,
                agentLaunchEnvironment: environment,
            })
                .getConnectionManager()
                .read(paired.connectionId, AbortSignal.timeout(20_000));

            expect(resumed.connectionId).toBe(paired.connectionId);
            expect(resumed).toEqual(paired);
            expect(relay.claims).toHaveLength(1);
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
