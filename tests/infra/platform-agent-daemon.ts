import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import WebSocket from "ws";
import {
    type AgentDaemonSocket,
    FakeAgentDaemon,
    type FakeAgentDaemonBehavior,
    serveFakeAgentDaemon,
} from "./agent-daemon.ts";
import type { TestServerApp } from "./server.ts";

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
    readonly behavior?: FakeAgentDaemonBehavior;
    readonly origin: string;
    readonly projectId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const resources = new AsyncDisposableStack();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    try {
        const pairing = v.parse(
            runtimePairingSchema,
            await (
                await options.server.request(
                    new Request(`${options.origin}/mobius/api/v1/projects/${options.projectId}/runtime-pairings`, {
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
                    new Request(`${options.origin}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
                        body: JSON.stringify({
                            agents: fakeAgentCatalog(options.behavior),
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
        const connected = resources.use(
            await connectFakeAgentDaemon({
                origin: options.origin,
                runtimeCredential: claim.runtimeCredential,
                signal,
                ...(options.behavior === undefined ? {} : { behavior: options.behavior }),
            }),
        );
        const client = new MobiusClient({
            endpoint: options.origin,
            projectId: pairing.projectId,
            credentialProvider: new StaticMobiusCredentialProvider(options.credential),
            transport: { fetch: async (request: Request) => await options.server.request(request) },
        });
        resources.defer(() => cancellation.abort(new Error("Fake Platform Runtime stopped")));
        const owned = resources.move();
        return {
            client,
            failure: connected.failure,
            runtimeId: pairing.runtimeId,
            publishSessionEvent: (sessionId: string, payload: string, eventSignal: AbortSignal) =>
                connected.publishSessionEvent(sessionId, payload, eventSignal),
            [Symbol.asyncDispose]: () => owned.disposeAsync(),
        };
    } finally {
        await resources.disposeAsync();
    }
}

export function fakeAgentCatalog(behavior?: FakeAgentDaemonBehavior) {
    return [
        { id: behavior?.agentId ?? "codex", name: behavior?.agentName ?? "Codex" },
        ...(behavior?.additionalAgents ?? []),
    ].map((agent) => ({
        agentSettingsDiscovery: true,
        sessionTurnConfiguration: true,
        agentPath: `/fake/${agent.id}`,
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
        id: agent.id,
        label: agent.name,
    }));
}

/** Opens the actual daemon transport with an already redeemed Runtime credential. */
export async function connectFakeAgentDaemon(options: {
    readonly origin: string;
    readonly runtimeCredential: string;
    readonly signal: AbortSignal;
    readonly behavior?: FakeAgentDaemonBehavior;
}) {
    const resources = new AsyncDisposableStack();
    const signal = options.signal;
    try {
        const relayUrl = new URL("/mobius/api/v1/runtimes/connect", options.origin);
        relayUrl.protocol = "ws:";
        const daemon = resources.use(
            await FakeAgentDaemon.connect(
                relayUrl,
                (url) => {
                    const socket = new WebSocket(url, {
                        headers: { authorization: `Bearer ${options.runtimeCredential}` },
                    });
                    return Object.assign(socket, {
                        sendBatch: async (messages: readonly string[]): Promise<void> =>
                            await new Promise<void>((resolve, reject) => {
                                let remaining = messages.length;
                                for (const message of messages) {
                                    socket.send(message, (error) => {
                                        if (error !== undefined && error !== null) {
                                            reject(error);
                                            return;
                                        }
                                        remaining -= 1;
                                        if (remaining === 0) {
                                            resolve();
                                        }
                                    });
                                }
                            }),
                    }) as unknown as AgentDaemonSocket;
                },
                signal,
            ),
        );
        const behavior = resources.use(
            serveFakeAgentDaemon(daemon, { ...options.behavior, agentName: options.behavior?.agentName ?? "Codex" }),
        );
        const owned = resources.move();
        return {
            failure: behavior.failure,
            publishSessionEvent: (sessionId: string, payload: string, eventSignal: AbortSignal) =>
                daemon.sendSessionEvent(sessionId, payload, eventSignal),
            [Symbol.asyncDispose]: () => owned.disposeAsync(),
        };
    } finally {
        await resources.disposeAsync();
    }
}
