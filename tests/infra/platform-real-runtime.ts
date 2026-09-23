import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { LocalAgentDefinition } from "../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../packages/cli/src/config.ts";
import { runDaemon } from "../../packages/cli/src/run-daemon.ts";

const pairingSchema = v.object({
    pairingId: v.string(),
    pairingCode: v.string(),
    channelId: v.string(),
    runtimeId: v.string(),
});

/** Runs the production local Runtime; only its ACP Agent process is fake. */
export async function createTestLocalRuntime(options: {
    readonly credential: string;
    readonly fakeAgentPath: string;
    readonly origin: string;
    readonly projectId: string;
    readonly request: (input: Request) => Promise<Response>;
    readonly signal: AbortSignal;
}) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-real-test-runtime-"));
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    const audit = new AuditStore();
    let running: Promise<void> | undefined;
    try {
        const pairingResponse = await options.request(
            new Request(`${options.origin}/mobius/api/v1/projects/${options.projectId}/runtime-pairings`, {
                body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
                headers: { authorization: `Bearer ${options.credential}`, "content-type": "application/json" },
                method: "POST",
                signal,
            }),
        );
        if (!pairingResponse.ok) {
            throw new Error(`Runtime pairing failed: ${pairingResponse.status.toString()}`);
        }
        const pairing = v.parse(pairingSchema, await pairingResponse.json());
        const agent = new LocalAgentDefinition(
            "claude",
            "Claude Code",
            process.execPath,
            [options.fakeAgentPath, "--agent-name", "Claude Code"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent") },
            "1.0.0",
            "1.0.0",
        );
        const claimResponse = await options.request(
            new Request(`${options.origin}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
                body: JSON.stringify({
                    agents: [
                        {
                            agentSettingsDiscovery: true,
                            sessionTurnConfiguration: true,
                            agentPath: agent.command,
                            agentVersion: "fake-acp-agent",
                            capabilities: agent.capabilities,
                            id: agent.id,
                            label: agent.label,
                        },
                    ],
                    installableAgents: [],
                    machineName: "Test Runtime",
                    pairingCode: pairing.pairingCode,
                    workspaceName: "Test workspace",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal,
            }),
        );
        if (!claimResponse.ok) {
            throw new Error(`Runtime claim failed: ${claimResponse.status.toString()}`);
        }
        const claim = v.parse(v.object({ runtimeCredential: v.string() }), await claimResponse.json());
        const workspace = join(stateDirectory, "workspace");
        await mkdir(workspace);
        const relayUrl = new URL("/mobius/api/v1/runtimes/connect", options.origin);
        relayUrl.protocol = "ws:";
        relayUrl.searchParams.set("token", claim.runtimeCredential);
        relayUrl.searchParams.set("deliveryReceipts", "1");
        const ready = Promise.withResolvers<void>();
        running = runDaemon(
            createDaemonConfig(
                { channelId: pairing.channelId, defaultWorkspace: workspace, relayUrl },
                [agent],
                [],
                new DaemonLocalContext(stateDirectory),
            ),
            audit,
            signal,
            undefined,
            {
                onConnectionStatus: (status) => {
                    if (status === "online") {
                        ready.resolve();
                    }
                },
            },
        );
        await Promise.race([
            ready.promise,
            running.then(() => {
                throw new Error("Runtime stopped before ready");
            }),
        ]);
        return {
            runtimeId: pairing.runtimeId,
            stateDirectory,
            seedNativeSession: async (
                sessionId: string,
                messages: readonly {
                    readonly role: "user" | "assistant";
                    readonly text: string;
                    readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
                }[],
            ) => {
                const directory = join(stateDirectory, "agent");
                await mkdir(directory, { recursive: true });
                await writeFile(
                    join(directory, `${encodeURIComponent(sessionId)}.json`),
                    JSON.stringify({
                        turnCount: messages.filter((message) => message.role === "assistant").length,
                        model: "test-small",
                        reasoningEffort: "medium",
                        fastMode: false,
                        mode: "code",
                        cwd: workspace,
                        title: messages[0]?.text ?? "Test conversation",
                        additionalDirectories: [],
                        history: messages.map((message, index) => ({
                            ...message,
                            messageId: `seed-${index.toString()}`,
                        })),
                    }),
                );
            },
            [Symbol.asyncDispose]: async () => {
                cancellation.abort(new Error("Test Runtime stopped"));
                await running;
                audit.close();
                await rm(stateDirectory, { recursive: true, force: true });
            },
        };
    } catch (error) {
        cancellation.abort(error);
        await running?.catch(() => undefined);
        audit.close();
        await rm(stateDirectory, { recursive: true, force: true });
        throw error;
    }
}
