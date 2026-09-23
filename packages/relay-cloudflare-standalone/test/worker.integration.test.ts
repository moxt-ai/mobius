import { env } from "cloudflare:workers";
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
        for (const sessionId of ["standalone-first-session", "standalone-second-session"]) {
            const session = await worker.fetch(
                new Request("https://standalone.test/mobius/api/v1/projects/standalone/sessions", {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${env.MOBIUS_STANDALONE_TOKEN}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        agentId: "codex",
                        bindingId: "workspace",
                        directoryId: "root",
                        policy: {
                            contentLimitBytes: 2_000_000,
                            hotEventLimit: 100,
                            idempotencyRetentionMilliseconds: 86_400_000,
                            level: "full",
                            retentionMilliseconds: 86_400_000,
                        },
                        runtimeId: Reflect.get(runtime, "runtimeId"),
                        sessionId,
                        title: "Standalone Session",
                    }),
                }),
                env,
            );
            expect(session.status).toBe(201);
            expect(await session.json()).toMatchObject({ sessionId });
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
                path: "/mobius/api/v1/projects/standalone/sessions/standalone-first-session",
                requestId: "read-session",
            }),
        );
        expect(await response).toMatchObject({ kind: "http.response", requestId: "read-session", status: 200 });
        const subscribed = nextMessage(socket);
        socket.send(
            JSON.stringify({
                headers: [["authorization", `Bearer ${env.MOBIUS_STANDALONE_TOKEN}`]],
                kind: "session.events.subscribe",
                path: "/mobius/api/v1/projects/standalone/sessions/standalone-first-session/events",
                subscriptionId: "first-session-events",
            }),
        );
        expect(await subscribed).toMatchObject({
            kind: "session.events.ready",
            subscriptionId: "first-session-events",
        });
        socket.close();
    });
});
