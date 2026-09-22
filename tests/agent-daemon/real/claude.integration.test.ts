import { it } from "vitest";
import { ClaudeFixture } from "../infra/claude.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeAnthropicProvider } from "../providers/anthropic.ts";
import { fakeProviderPrompts } from "../providers/scenarios.ts";

it("Given real Claude Code and claude-agent-acp use a local Anthropic upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeAnthropicProvider.start(
        "claude-sonnet-4-6",
        "Response from Claude Code through the local fake provider",
    );
    await using claude = await ClaudeFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: claude.environment,
        agentId: "claude",
        agentPath: claude.executable,
        prompt: fakeProviderPrompts.streamedTool,
        sessionId: "real-claude-local-provider",
        signal,
        title: "Real Claude local provider",
    });

    try {
        await runAgentDaemonTurn(journey);
        await expectPersistedToolTurn(journey, provider.responseFor(journey.prompt));
    } catch (error) {
        process.stderr.write(
            `Claude integration diagnostics:\n${JSON.stringify(
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
