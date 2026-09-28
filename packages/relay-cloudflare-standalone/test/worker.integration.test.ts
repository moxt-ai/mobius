import { env } from "cloudflare:workers";
import {
    MobiusBrowserCredentialRequest,
    MobiusClient,
    type MobiusHttpTransport,
    MobiusRuntimePairingRequest,
    MobiusStandaloneCredentialProvider,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";
import { describe, expect, it } from "vitest";
import { createStandaloneWorker } from "../src/worker.ts";

function nextMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
        socket.addEventListener(
            "message",
            (event) => {
                if (typeof event.data !== "string") {
                    reject(new Error("The transport returned a non-text message"));
                    return;
                }
                resolve(JSON.parse(event.data));
            },
            { once: true },
        );
    });
}

describe("Standalone Relay", () => {
    it("Given the Standalone Web app, When it bootstraps browser access, Then it can create a Runtime pairing without receiving the deployment credential", async () => {
        const worker = createStandaloneWorker();
        const transport: MobiusHttpTransport = {
            fetch: async (request) => await worker.fetch(request, env),
        };
        const provider = new MobiusStandaloneCredentialProvider({
            endpoint: "https://standalone.test",
            transport,
        });
        const client = new MobiusClient({
            credentialProvider: provider,
            endpoint: "https://standalone.test",
            projectId: "standalone",
            transport,
        });
        const credential = await provider.browserCredential(AbortSignal.timeout(5_000));
        expect(credential.projectId).toBe("standalone");
        expect(credential.token).not.toBe(env.MOBIUS_STANDALONE_TOKEN);

        const pairing = await client.runtimePairings.create(
            new MobiusRuntimePairingRequest("browser-machine"),
            AbortSignal.timeout(5_000),
        );
        expect(pairing.projectId).toBe("standalone");
        await expect(
            client.credentials.issue(new MobiusBrowserCredentialRequest(60), AbortSignal.timeout(5_000)),
        ).rejects.toMatchObject({ code: "project_permission_denied" });

        const owner = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(env.MOBIUS_STANDALONE_TOKEN),
            endpoint: "https://standalone.test",
            projectId: "standalone",
            transport,
        });
        const delegated = await owner.credentials.issue(
            new MobiusBrowserCredentialRequest(60),
            AbortSignal.timeout(5_000),
        );
        expect(delegated.token).not.toBe(env.MOBIUS_STANDALONE_TOKEN);
        await owner.credentials.revoke(delegated.credentialId, AbortSignal.timeout(5_000));

        const compatibilityRoute = await worker.fetch(
            new Request("https://standalone.test/mobius/api/pairings", { method: "POST" }),
            env,
        );
        expect(compatibilityRoute.status).toBe(404);
        owner.close();
        client.close();
    });

    it("Given a self-hosted Relay, When its owner creates a Runtime pairing, Then the pairing is usable without Platform credentials", async () => {
        const worker = createStandaloneWorker();
        const url = "https://standalone.test/mobius/api/v1/projects/standalone/runtime-pairings";
        const request = (credential: string) =>
            new Request(url, {
                method: "POST",
                headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
                body: JSON.stringify({ idempotencyKey: "first-machine" }),
            });

        const denied = await worker.fetch(request("wrong_secret_0123456789abcdef000000"), env);
        expect(denied.status).toBe(401);
        const platform = await worker.fetch(
            new Request("https://standalone.test/mobius/api/dashboard/v1/platform"),
            env,
        );
        expect(platform.status).toBe(404);

        const created = await worker.fetch(request(env.MOBIUS_STANDALONE_TOKEN), env);
        expect(created.status).toBe(201);
        const pairing: unknown = await created.json();
        expect(pairing).toMatchObject({ projectId: "standalone" });
        if (typeof pairing !== "object" || pairing === null) {
            throw new Error("The pairing response is invalid");
        }
        const pairingId = Reflect.get(pairing, "pairingId");
        const pairingCode = Reflect.get(pairing, "pairingCode");
        if (typeof pairingId !== "string" || typeof pairingCode !== "string") {
            throw new Error("The pairing response is incomplete");
        }
        const redeemed = await worker.fetch(
            new Request(`https://standalone.test/mobius/api/v1/runtime-pairings/${pairingId}/redeem`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    agents: [
                        {
                            agentPath: "/usr/local/bin/codex",
                            agentVersion: "codex 1.0.0",
                            capabilities: {
                                additionalDirectories: true,
                                audioPrompt: false,
                                closeSession: true,
                                deleteSession: true,
                                embeddedContextPrompt: true,
                                imagePrompt: true,
                                listSessions: true,
                                loadSession: true,
                                promptQueueing: false,
                                resumeSession: true,
                                steering: false,
                                unstableForkSession: false,
                            },
                            id: "codex",
                            label: "Codex",
                            sessionTurnConfiguration: true,
                        },
                    ],
                    installableAgents: [],
                    machineName: "My machine",
                    pairingCode,
                    workspaceName: "workspace",
                }),
            }),
            env,
        );
        expect(redeemed.status).toBe(200);
        const runtime: unknown = await redeemed.json();
        expect(runtime).toMatchObject({ appId: "standalone", runtimeId: Reflect.get(pairing, "runtimeId") });
        if (typeof runtime !== "object" || runtime === null || typeof Reflect.get(runtime, "runtimeId") !== "string") {
            throw new Error("The Runtime response is invalid");
        }
        const transport = await worker.fetch(
            new Request("https://standalone.test/mobius/api/v1/transport", {
                headers: { Upgrade: "websocket" },
            }),
            env,
        );
        expect(transport.status).toBe(101);
        const socket = transport.webSocket;
        if (socket === null) {
            throw new Error("The standalone transport did not provide a WebSocket");
        }
        socket.accept();
        const response = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: "",
                headers: [["authorization", `Bearer ${env.MOBIUS_STANDALONE_TOKEN}`]],
                kind: "http.request",
                method: "GET",
                path: "/mobius/api/v1/projects/standalone/runtimes",
                requestId: "list-runtimes",
            }),
        );
        expect(await response).toMatchObject({ kind: "http.response", requestId: "list-runtimes", status: 200 });
        socket.close();
    });
});
