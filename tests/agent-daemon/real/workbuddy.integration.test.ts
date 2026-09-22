import { it } from "vitest";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { WorkBuddyFixture } from "../infra/workbuddy.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

it("Given real WorkBuddy uses a local OpenAI-compatible upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "mobius-workbuddy",
        "Response from WorkBuddy through the local fake provider",
    );
    await using workBuddy = await WorkBuddyFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: workBuddy.environment,
        agentId: "workbuddy",
        agentPath: workBuddy.executable,
        prompt: fakeProviderPrompts.twoTools,
        sessionId: "real-workbuddy-local-provider",
        signal,
        title: "Real WorkBuddy local provider",
    });

    try {
        await runAgentDaemonTurn(journey);
        await expectPersistedToolTurn(journey, provider.responseFor(journey.prompt), { toolCount: 2 });
    } catch (error) {
        process.stderr.write(
            `WorkBuddy integration diagnostics:\n${JSON.stringify(
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
