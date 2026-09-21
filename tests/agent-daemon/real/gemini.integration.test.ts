import { it } from "vitest";
import { GeminiFixture } from "../infra/gemini.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeGeminiProvider } from "../providers/gemini.ts";

it("Given real Gemini CLI uses a local Gemini upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeGeminiProvider.start("Response from Gemini through the local fake provider");
    await using gemini = await GeminiFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: gemini.environment,
        agentId: "gemini-cli",
        agentPath: gemini.executable,
        sessionId: "real-gemini-local-provider",
        signal,
        title: "Real Gemini local provider",
    });

    await runAgentDaemonTurn(journey);
    await expectPersistedToolTurn(journey, provider.response);
});
