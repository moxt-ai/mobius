import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mobiusApiPath } from "@moxt-ai/mobius-protocol";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk/server";
import * as v from "valibot";
import { createDaemonConfig, DaemonLocalContext } from "../../src/config.ts";
import { runDaemon } from "../../src/run-daemon.ts";
import {
    defaultFakeAgentHarness,
    type FakeAgentHarnessDefinition,
    fakeAgentHarness,
    fakeAgentHarnessCapabilities,
} from "./agent-harness.ts";

type TestServerApp = { readonly request: (request: Request) => Response | Promise<Response> };

const runtimePairingSchema = v.object({
    pairingId: v.string(),
    projectId: v.string(),
    runtimeId: v.string(),
    channelId: v.string(),
    pairingCode: v.string(),
});

export function fakeAgentHarnessCatalog(definitions: readonly FakeAgentHarnessDefinition[]) {
    return definitions.map((agent) => ({
        agentSettingsDiscovery: true,
        sessionTurnConfiguration: true,
        agentPath: `/controlled-harness/${agent.id}`,
        agentVersion: "controlled-harness",
        capabilities: fakeAgentHarnessCapabilities(agent),
        id: agent.id,
        label: agent.label,
    }));
}

/** Runs the production daemon with only its external Agent harness controlled. */
export async function createFakeAgentHarnessRuntime(options: {
    readonly credential: string;
    readonly harnesses?: readonly FakeAgentHarnessDefinition[];
    readonly nativeSessionIds?: ReadonlySet<string>;
    readonly origin: string;
    readonly projectId: string;
    readonly server: TestServerApp;
    readonly signal: AbortSignal;
}) {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    const directory = await mkdtemp(join(tmpdir(), "mobius-agent-harness-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    let daemon: Promise<void> | undefined;
    try {
        await Promise.all([mkdir(workspace), mkdir(harnessState)]);
        await Promise.all(
            [...(options.nativeSessionIds ?? [])].map(async (sessionId) =>
                writeFile(
                    join(harnessState, `${encodeURIComponent(sessionId)}.json`),
                    JSON.stringify({
                        additionalDirectories: [],
                        cwd: workspace,
                        fastMode: false,
                        history: [],
                        mode: "code",
                        model: "test-small",
                        reasoningEffort: "medium",
                        title: `Native ${sessionId}`,
                        turnCount: 1,
                    }),
                ),
            ),
        );
        const harnesses = options.harnesses ?? [defaultFakeAgentHarness];
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
                            agents: fakeAgentHarnessCatalog(harnesses),
                            installableAgents: [],
                            machineName: "Controlled Agent harness",
                            pairingCode: pairing.pairingCode,
                            workspaceName: "Controlled workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                        signal,
                    }),
                )
            ).json(),
        );
        const relayUrl = new URL(mobiusApiPath("/v1/runtimes/connect"), options.origin);
        relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
        relayUrl.searchParams.set("token", claim.runtimeCredential);
        const localContext = new DaemonLocalContext(directory, process.env);
        const config = createDaemonConfig(
            { channelId: pairing.channelId, defaultWorkspace: workspace, relayUrl },
            harnesses.map((definition) => fakeAgentHarness(definition, harnessState)),
            [],
            localContext,
        );
        daemon = runDaemon(config, signal);
        void daemon.catch((error: unknown) => {
            if (!signal.aborted) {
                console.error("Controlled Agent harness daemon failed", error);
            }
        });
        const failure = daemon.then<never>(() => {
            throw new Error("The production daemon stopped unexpectedly");
        });
        void failure.catch(() => undefined);
        const client = new MobiusClient({
            endpoint: options.origin,
            projectId: pairing.projectId,
            credentialProvider: new StaticMobiusCredentialProvider(options.credential),
            transport: { fetch: async (request: Request) => await options.server.request(request) },
        });
        let disposed = false;
        return {
            client,
            failure,
            runtimeId: pairing.runtimeId,
            [Symbol.asyncDispose]: async () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                cancellation.abort(new Error("Controlled Agent harness Runtime stopped"));
                await daemon?.catch(() => undefined);
                await rm(directory, { recursive: true, force: true });
            },
        };
    } catch (cause) {
        cancellation.abort(cause);
        await daemon?.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
        throw cause;
    }
}
