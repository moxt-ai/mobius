import { it } from "vitest";
import { DeepSeekFixture } from "../infra/deepseek.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

it("Given real DeepSeek Harness uses a local DeepSeek upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "deepseek-chat",
        "Response from DeepSeek Harness through the local fake provider",
        { fallbackPrompt: fakeProviderPrompts.streamedTool },
    );
    await using deepSeek = await DeepSeekFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: deepSeek.environment,
        agentId: "deepseek-harness",
        agentPath: deepSeek.executable,
        prompt: fakeProviderPrompts.streamedTool,
        sessionId: "real-deepseek-local-provider",
        signal,
        title: "Real DeepSeek Harness local provider",
    });

    try {
        await runAgentDaemonTurn(journey);
        await expectPersistedToolTurn(journey, provider.responseFor(journey.prompt));
    } catch (error) {
        process.stderr.write(
            `DeepSeek Harness integration diagnostics:\n${JSON.stringify(
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
