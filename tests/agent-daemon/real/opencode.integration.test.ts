import { it } from "vitest";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { OpenCodeFixture } from "../infra/opencode.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real OpenCode configured with a local provider, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "mobius-test-model",
        "Response from OpenCode through the local fake provider",
    );
    await using openCode = await OpenCodeFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: openCode.environment,
        agentId: "opencode",
        agentPath: openCode.executable,
        sessionId: "real-opencode-local-provider",
        signal,
        title: "Real OpenCode local provider",
    });

    await runAgentDaemonTurn(journey);
    await expectPersistedToolTurn(journey, provider.response, { exactResponse: true });
});
