import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import { createDaemonConfig, MobiusRuntimeEngine } from "../../packages/cli/src/runtime.ts";
import type { createTestAgent } from "./agent.ts";
import { serveTestApp, type TestServerApp } from "./server.ts";

const pairingSchema = v.object({
    projectId: v.string(),
    runtimeId: v.string(),
    channelId: v.string(),
    pairingCode: v.string(),
    hostToken: v.string(),
});
const runtimePairingSchema = v.object({
    pairingId: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
    channelId: v.string(),
    pairingCode: v.string(),
});

/** Owns a production Runtime; the Agent and server remain owned by the calling test. */
export async function createTestRuntime(options: {
    readonly server: TestServerApp;
    readonly agent: Awaited<ReturnType<typeof createTestAgent>>;
    readonly signal: AbortSignal;
    readonly project?: { readonly projectId: string; readonly credential: string };
}) {
    const resources = new AsyncDisposableStack();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    signal.throwIfAborted();
    const ready = Promise.withResolvers<void>();
    const onAbort = () => ready.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    resources.defer(() => signal.removeEventListener("abort", onAbort));
    // Observe the rejection immediately, including failures during resource acquisition.
    void ready.promise.catch(() => undefined);
    try {
        const server = resources.use(
            await serveTestApp({
                app: options.server,
                signal,
                onServerMessage: (message) => {
                    const value: unknown = JSON.parse(message);
                    const kind = v.parse(v.object({ kind: v.string() }), value).kind;
                    if (kind === "runtime.liveness.ready") {
                        ready.resolve();
                    }
                },
            }),
        );
        const directory = await mkdtemp(join(tmpdir(), "mobius-test-runtime-"));
        resources.defer(() => rm(directory, { recursive: true, force: true }));
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        process.env["MOBIUS_STATE_DIRECTORY"] = directory;
        resources.defer(() => {
            if (previousStateDirectory === undefined) {
                delete process.env["MOBIUS_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_STATE_DIRECTORY"] = previousStateDirectory;
            }
        });
        const project = options.project;
        const pairing =
            project === undefined
                ? v.parse(
                      pairingSchema,
                      await (
                          await options.server.request(
                              new Request(`${server.origin}/mobius/api/pairings`, {
                                  method: "POST",
                                  signal,
                              }),
                          )
                      ).json(),
                  )
                : {
                      ...v.parse(
                          runtimePairingSchema,
                          await (
                              await options.server.request(
                                  new Request(
                                      `${server.origin}/mobius/api/v1/projects/${project.projectId}/runtime-pairings`,
                                      {
                                          method: "POST",
                                          signal,
                                          headers: {
                                              authorization: `Bearer ${project.credential}`,
                                              "content-type": "application/json",
                                          },
                                          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                                      },
                                  ),
                              )
                          ).json(),
                      ),
                      hostToken: project.credential,
                  };
        const agent = options.agent.definition;
        const claimPath =
            "pairingId" in pairing
                ? `/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`
                : "/mobius/api/pairings/claim";
        const claimResponse = await options.server.request(
            new Request(`${server.origin}${claimPath}`, {
                method: "POST",
                signal,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    pairingCode: pairing.pairingCode,
                    agents: [
                        {
                            id: agent.id,
                            label: agent.label,
                            agentPath: agent.agentIdentity.requestedPath,
                            agentVersion: agent.agentVersion,
                            capabilities: agent.capabilities,
                        },
                    ],
                    installableAgents: [],
                    machineName: "Test Runtime",
                    workspaceName: options.agent.workspace,
                }),
            }),
        );
        const claim: unknown = await claimResponse.json();
        const runtimeCredential =
            "pairingId" in pairing
                ? v.parse(v.object({ runtimeCredential: v.string() }), claim).runtimeCredential
                : v.parse(v.object({ daemonToken: v.string() }), claim).daemonToken;
        const relayUrl = new URL("/mobius/api/v1/runtimes/connect", server.origin);
        relayUrl.protocol = "ws:";
        relayUrl.searchParams.set("token", runtimeCredential);
        const engine = new MobiusRuntimeEngine(
            createDaemonConfig(
                {
                    relayUrl,
                    channelId: pairing.channelId,
                    defaultWorkspace: options.agent.workspace,
                    auditDatabasePath: join(directory, "audit.sqlite"),
                },
                [agent],
            ),
        );
        const running = engine.run(signal);
        resources.defer(async () => {
            cancellation.abort();
            await running;
        });
        void running.then(
            () => ready.reject(new Error("The Runtime stopped before connecting")),
            (cause: unknown) => ready.reject(cause),
        );
        await ready.promise;
        signal.removeEventListener("abort", onAbort);
        const clientOptions = {
            endpoint: server.origin,
            projectId: pairing.projectId,
            credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
            transport: { fetch: async (request: Request) => await options.server.request(request) },
        };
        const client = new MobiusClient(clientOptions);
        resources.defer(() => client.close());
        const owned = resources.move();
        return {
            client,
            runtimeId: pairing.runtimeId,
            [Symbol.asyncDispose]: () => owned.disposeAsync(),
        };
    } finally {
        await resources.disposeAsync();
    }
}
