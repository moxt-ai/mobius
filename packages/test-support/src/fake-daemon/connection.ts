import { decodeMessageKind } from "@moxt-ai/mobius-protocol";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import WebSocket from "ws";
import { fakeDaemonCapabilities } from "./catalog.ts";
import type { FakeDaemonOptions } from "./model.ts";
import { FakeAgentDaemon } from "./peer.ts";

type TestServerApp = { readonly request: (request: Request) => Promise<Response> };

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
    readonly behavior: FakeDaemonOptions;
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
                behavior: options.behavior,
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
            [Symbol.asyncDispose]: () => owned.disposeAsync(),
        };
    } finally {
        await resources.disposeAsync();
    }
}

export function fakeAgentCatalog(behavior?: FakeDaemonOptions) {
    return [
        { id: behavior?.agentId ?? "codex", name: behavior?.agentName ?? "Codex" },
        ...(behavior?.additionalAgents ?? []),
    ].map((agent) => ({
        agentSettingsDiscovery: true,
        sessionTurnConfiguration: true,
        agentPath: `/fake/${agent.id}`,
        agentVersion: "fake-agent-daemon",
        capabilities: fakeDaemonCapabilities,
        id: agent.id,
        label: agent.name,
    }));
}

/** Opens the actual daemon transport with an already redeemed Runtime credential. */
export async function connectFakeAgentDaemon(options: {
    readonly origin: string;
    readonly runtimeCredential: string;
    readonly signal: AbortSignal;
    readonly behavior: FakeDaemonOptions;
}) {
    options.signal.throwIfAborted();
    const url = new URL("/mobius/api/v1/runtimes/connect", options.origin);
    url.searchParams.set("liveness", "1");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${options.runtimeCredential}` } });
    const failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => {});
    let stopping = false;
    const daemon = new FakeAgentDaemon((message) => socket.send(message), options.behavior);
    const closed = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    socket.on("message", (data) => {
        try {
            const message = data.toString();
            daemon.receive(message);
            if (decodeMessageKind(message) === "runtime.liveness.ready") {
                ready.resolve();
            }
        } catch (cause) {
            ready.reject(cause);
            failed.reject(cause);
        }
    });
    socket.on("error", (cause) => {
        ready.reject(cause);
        if (!stopping) {
            failed.reject(cause);
        }
    });
    socket.on("close", () => {
        options.signal.removeEventListener("abort", stop);
        closed.resolve();
        if (!stopping) {
            const error = new Error("Fake daemon disconnected");
            ready.reject(error);
            failed.reject(error);
        }
    });
    const stop = () => {
        stopping = true;
        socket.terminate();
    };
    options.signal.addEventListener("abort", stop, { once: true });
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
    const abort = () => {
        ready.reject(signal.reason);
        stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        await ready.promise;
    } catch (cause) {
        stop();
        await closed.promise;
        throw cause;
    } finally {
        signal.removeEventListener("abort", abort);
    }
    return {
        failure: failed.promise,
        [Symbol.asyncDispose]: async () => {
            stop();
            await closed.promise;
        },
    };
}
