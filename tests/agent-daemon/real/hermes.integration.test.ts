import { it } from "vitest";
import { HermesFixture } from "../infra/hermes.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

it("Given real Hermes uses a local OpenAI-compatible upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "mobius-test-model",
        "Response from Hermes through the local fake provider",
    );
    await using hermes = await HermesFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: hermes.environment,
        agentId: "hermes",
        agentPath: hermes.executable,
        prompt: fakeProviderPrompts.streamedTool,
        sessionId: "real-hermes-local-provider",
        signal,
        title: "Real Hermes local provider",
    });

    try {
        await runAgentDaemonTurn(journey);
        await expectPersistedToolTurn(journey, provider.responseFor(journey.prompt));
    } catch (error) {
        process.stderr.write(
            `Hermes integration diagnostics:\n${JSON.stringify(
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
