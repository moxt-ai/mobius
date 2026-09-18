import { expect, it } from "vitest";
import { CopilotFixture } from "../infra/copilot.ts";
import {
    allowOneTimeToolPermission,
    expectPersistedToolTurn,
    runAgentDaemonTurn,
    startAgentDaemonJourney,
} from "../infra/journey.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real GitHub Copilot CLI uses a local OpenAI upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "gpt-4.1",
        "Response from GitHub Copilot CLI through the local fake provider",
    );
    await using copilot = await CopilotFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: copilot.environment,
        agentId: "github-copilot-cli",
        agentPath: copilot.executable,
        sessionId: "real-copilot-local-provider",
        signal,
        title: "Real Copilot local provider",
    });

    try {
        await runAgentDaemonTurn(journey, {
            afterSubmit: () => allowOneTimeToolPermission(journey),
            completionTimeoutMilliseconds: 40_000,
        });
        await expectPersistedToolTurn(journey, provider.response);
        expect(provider.diagnostics()).toEqual([
            expect.objectContaining({
                hasToolResult: false,
                selectedTool: { kind: "function", name: "bash" },
            }),
            expect.objectContaining({
                hasToolResult: true,
                selectedTool: undefined,
            }),
        ]);
    } catch (error) {
        process.stderr.write(
            `GitHub Copilot CLI integration diagnostics:\n${JSON.stringify(
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
