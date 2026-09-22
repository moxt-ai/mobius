import { it } from "vitest";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { PiFixture } from "../infra/pi.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

it("Given real Pi and pi-acp use a local OpenAI upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "gpt-5.5",
        "Response from Pi through the local fake provider",
    );
    await using pi = await PiFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: pi.environment,
        agentId: "pi",
        agentPath: pi.executable,
        prompt: fakeProviderPrompts.successfulTool,
        sessionId: "real-pi-local-provider",
        signal,
        title: "Real Pi local provider",
    });

    await runAgentDaemonTurn(journey);
    await expectPersistedToolTurn(journey, provider.responseFor(journey.prompt));
});
