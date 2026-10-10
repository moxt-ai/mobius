import { env } from "cloudflare:workers";
import { decodeServiceToDaemonMessage, encodeDaemonToServiceMessage } from "@moxt-ai/mobius-protocol";
import {
    MobiusBrowserCredentialRequest,
    MobiusClient,
    type MobiusHttpTransport,
    MobiusRuntimePairingRequest,
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
    it("Given a malformed encoded Session target, When recorded history is requested, Then the Relay rejects it without throwing", async () => {
        const worker = createStandaloneWorker();
        const response = await worker.fetch(
            new Request(
                "https://standalone.test/mobius/api/v1/projects/%E0%A4%A/recording/sessions/session-1/events?runtimeId=runtime-1",
            ),
            env,
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    });

    it("Given two Standalone pairing workflows, When each Project chooses Recording, Then their Projects and policies are independent", async () => {
        const worker = createStandaloneWorker();
        const createProject = async (): Promise<{ readonly projectId: string; readonly token: string }> => {
            const response = await worker.fetch(
                new Request("https://standalone.test/mobius/api/v1/standalone/projects", { method: "POST" }),
                env,
            );
            expect(response.status).toBe(201);
            return await response.json<{ readonly projectId: string; readonly token: string }>();
        };
        const first = await createProject();
        const second = await createProject();
        expect(first.projectId).not.toBe(second.projectId);

        const recordingRequest = (
            project: { readonly projectId: string; readonly token: string },
            method: "GET" | "PUT",
            body?: object,
        ) =>
            new Request(`https://standalone.test/mobius/api/v1/projects/${project.projectId}/recording`, {
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                headers: {
                    authorization: `Bearer ${project.token}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                method,
            });

        const firstInitial = await worker.fetch(recordingRequest(first, "GET"), env);
        expect(firstInitial.status).toBe(200);
        expect(await firstInitial.json()).toEqual({ providerAvailable: false, state: "unconfigured" });

        const unavailable = await worker.fetch(recordingRequest(first, "PUT", { enabled: true }), env);
        expect(unavailable.status).toBe(409);
        expect(await unavailable.json()).toMatchObject({ error: { code: "recording_provider_unavailable" } });

        const configured = await worker.fetch(recordingRequest(first, "PUT", { enabled: false }), env);
        expect(configured.status).toBe(200);
        expect(await configured.json()).toEqual({ enabled: false, providerAvailable: false, state: "configured" });

        const secondInitial = await worker.fetch(recordingRequest(second, "GET"), env);
        expect(secondInitial.status).toBe(200);
        expect(await secondInitial.json()).toEqual({ providerAvailable: false, state: "unconfigured" });

        const locked = await worker.fetch(recordingRequest(first, "PUT", { enabled: true }), env);
        expect(locked.status).toBe(409);
        expect(await locked.json()).toMatchObject({ error: { code: "recording_configuration_locked" } });
    });

    it("Given the Standalone Web app, When it bootstraps browser access, Then it can create a Runtime pairing without receiving the deployment credential", async () => {
        const worker = createStandaloneWorker();
        const transport: MobiusHttpTransport = {
            fetch: async (request) => await worker.fetch(request, env),
        };
        const projectResponse = await transport.fetch(
            new Request("https://standalone.test/mobius/api/v1/standalone/projects", {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
                signal: AbortSignal.timeout(5_000),
            }),
        );
        expect(projectResponse.status).toBe(201);
        const credential = await projectResponse.json<{ readonly projectId: string; readonly token: string }>();
        const provider = new StaticMobiusCredentialProvider(credential.token);
        const client = new MobiusClient({
            credentialProvider: provider,
            endpoint: "https://standalone.test",
            projectId: credential.projectId,
            transport,
        });
        expect(credential.projectId).toMatch(/^prj_/u);
        expect(credential.token).not.toBe(env.MOBIUS_STANDALONE_TOKEN);

        const pairing = await client.runtimePairings.create(
            new MobiusRuntimePairingRequest("browser-machine"),
            AbortSignal.timeout(5_000),
        );
        expect(pairing.projectId).toBe(credential.projectId);
        const delegated = await client.credentials.issue(
            new MobiusBrowserCredentialRequest(60),
            AbortSignal.timeout(5_000),
        );
        expect(delegated.token).not.toBe(credential.token);
        await client.credentials.revoke(delegated.credentialId, AbortSignal.timeout(5_000));

        const owner = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider(env.MOBIUS_STANDALONE_TOKEN),
            endpoint: "https://standalone.test",
            projectId: credential.projectId,
            transport,
        });
        const deploymentDelegated = await owner.credentials.issue(
            new MobiusBrowserCredentialRequest(60),
            AbortSignal.timeout(5_000),
        );
        expect(deploymentDelegated.token).not.toBe(env.MOBIUS_STANDALONE_TOKEN);
        await owner.credentials.revoke(deploymentDelegated.credentialId, AbortSignal.timeout(5_000));

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
        const createdProject = await worker.fetch(
            new Request("https://standalone.test/mobius/api/v1/standalone/projects", { method: "POST" }),
            env,
        );
        const project = await createdProject.json<{ readonly projectId: string }>();
        const url = `https://standalone.test/mobius/api/v1/projects/${project.projectId}/runtime-pairings`;
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
        expect(pairing).toMatchObject({ projectId: project.projectId });
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
                path: `/mobius/api/v1/projects/${project.projectId}/runtimes`,
                requestId: "list-runtimes",
            }),
        );
        expect(await response).toMatchObject({ kind: "http.response", requestId: "list-runtimes", status: 200 });
        socket.close();
        const runtimeId = Reflect.get(runtime, "runtimeId");
        const runtimeCredential = Reflect.get(runtime, "runtimeCredential");
        if (typeof runtimeId !== "string" || typeof runtimeCredential !== "string") {
            throw new Error("Missing Runtime credential");
        }
        const daemonResponse = await worker.fetch(
            new Request(`https://standalone.test/mobius/api/v1/runtimes/connect`, {
                headers: { Upgrade: "websocket", authorization: `Bearer ${runtimeCredential}` },
            }),
            env,
        );
        expect(daemonResponse.status).toBe(101);
        const daemon = daemonResponse.webSocket;
        if (daemon === null) {
            throw new Error("Missing daemon socket");
        }
        daemon.accept();
        daemon.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }
            const command = decodeServiceToDaemonMessage(event.data);
            if (command.kind === "runtime.diagnostics.read") {
                daemon.send(
                    encodeDaemonToServiceMessage({
                        kind: "runtime.diagnostics.result",
                        requestId: command.requestId,
                        version: "test-daemon",
                        truncated: false,
                        entries: [
                            {
                                event: "session_prepare_failed",
                                requestId: "failed-command",
                                failureCode: "agent_exited",
                            },
                        ],
                    }),
                );
            }
        });
        try {
            const diagnosticUrl = `https://standalone.test/mobius/api/v1/projects/${project.projectId}/runtimes/${runtimeId}/diagnostics`;
            const deniedDiagnostics = await worker.fetch(new Request(diagnosticUrl), env);
            expect(deniedDiagnostics.status).toBe(401);
            const diagnostics = await worker.fetch(
                new Request(diagnosticUrl, { headers: { authorization: `Bearer ${env.MOBIUS_STANDALONE_TOKEN}` } }),
                env,
            );
            expect(diagnostics.status).toBe(200);
            expect(diagnostics.headers.get("Cache-Control")).toBe("no-store");
            expect(await diagnostics.json()).toMatchObject({
                kind: "runtime.diagnostics.result",
                entries: [
                    { event: "session_prepare_failed", requestId: "failed-command", failureCode: "agent_exited" },
                ],
            });
        } finally {
            daemon.close();
        }
    });
});
