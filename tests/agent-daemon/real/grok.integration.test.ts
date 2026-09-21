import { it } from "vitest";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import { GrokFixture } from "../infra/grok.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real Grok Build uses a local OpenAI-compatible upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "grok-build",
        "Response from Grok Build through the local fake provider",
    );
    await using grok = await GrokFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: grok.environment,
        agentId: "grok-build",
        agentPath: grok.executable,
        onDiscoveryFailure: async (daemon) => {
            const diagnostics = await discoverLocalAgentInventory({
                defaultWorkspace: process.cwd(),
                environment: { ...process.env, ...grok.environment },
                signal,
            });
            process.stderr.write(
                `Grok Build discovery diagnostics:\n${JSON.stringify(
                    diagnostics.unavailable.map(({ code, message, specification, status }) => ({
                        code,
                        id: specification.id,
                        message,
                        status,
                    })),
                    null,
                    2,
                )}\n${daemon.output}\n`,
            );
        },
        sessionId: "real-grok-local-provider",
        signal,
        title: "Real Grok Build local provider",
    });

    try {
        await runAgentDaemonTurn(journey);
        await expectPersistedToolTurn(journey, provider.response);
    } catch (error) {
        process.stderr.write(
            `Grok Build integration diagnostics:\n${JSON.stringify(
                {
                    daemonOutput: journey.daemon.output,
                    messages: await journey.messages(),
                    providerRequests: provider.diagnostics(),
                },
                null,
                2,
            )}\n`,
        );
        throw error;
    }
});
