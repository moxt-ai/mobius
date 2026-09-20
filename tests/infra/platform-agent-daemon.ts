import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import WebSocket from "ws";
import { type AgentDaemonSocket, FakeAgentDaemon, serveFakeAgentDaemon } from "./agent-daemon.ts";
import { serveTestApp, type TestServerApp } from "./server.ts";

const runtimePairingSchema = v.object({
    pairingId: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
    channelId: v.string(),
    pairingCode: v.string(),
});

/** Connects the shared fake through the production Platform Runtime protocol. */
export async function createFakeAgentDaemonRuntime(options: {
    readonly credential: string;
    readonly projectId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const resources = new AsyncDisposableStack();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    try {
        const server = resources.use(
            await serveTestApp({
                app: options.server,
                signal,
                onServerMessage: () => undefined,
            }),
        );
        const pairing = v.parse(
            runtimePairingSchema,
            await (
                await options.server.request(
                    new Request(`${server.origin}/mobius/api/v1/projects/${options.projectId}/runtime-pairings`, {
                        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                        headers: {
                            authorization: `Bearer ${options.credential}`,
                            "content-type": "application/json",
                        },
                        method: "POST",
                        signal,
                    }),
                )
            ).json(),
        );
        const claim = v.parse(
            v.object({ runtimeCredential: v.string() }),
            await (
                await options.server.request(
                    new Request(`${server.origin}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
                        body: JSON.stringify({
                            agents: [
                                {
                                    agentPath: "/fake/codex",
                                    agentVersion: "fake-agent-daemon",
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
                                },
                            ],
                            installableAgents: [],
                            machineName: "Fake Runtime",
                            pairingCode: pairing.pairingCode,
                            workspaceName: "Fake workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal,
                    }),
                )
            ).json(),
        );
        const relayUrl = new URL("/mobius/api/v1/runtimes/connect", server.origin);
        relayUrl.protocol = "ws:";
        const daemon = resources.use(
            await FakeAgentDaemon.connect(
                relayUrl,
                (url) =>
                    new WebSocket(url, {
                        headers: { authorization: `Bearer ${claim.runtimeCredential}` },
                    }) as unknown as AgentDaemonSocket,
                signal,
            ),
        );
        const behavior = resources.use(serveFakeAgentDaemon(daemon, { agentName: "Codex" }));
        const client = new MobiusClient({
            endpoint: server.origin,
            projectId: pairing.projectId,
            credentialProvider: new StaticMobiusCredentialProvider(options.credential),
            transport: { fetch: async (request: Request) => await options.server.request(request) },
        });
        resources.defer(() => client.close());
        resources.defer(() => cancellation.abort(new Error("Fake Platform Runtime stopped")));
        const owned = resources.move();
        return {
            client,
            failure: behavior.failure,
            runtimeId: pairing.runtimeId,
            [Symbol.asyncDispose]: () => owned.disposeAsync(),
        };
    } finally {
        await resources.disposeAsync();
    }
}
