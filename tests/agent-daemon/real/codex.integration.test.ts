import { it } from "vitest";
import { MobiusAgentActivityEvent } from "../../../packages/mobius-sdk/src/server.ts";
import { CodexFixture } from "../infra/codex.ts";
import { expectPersistedToolTurn, runAgentDaemonTurn, startAgentDaemonJourney } from "../infra/journey.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real Codex and Mobius' in-process ACP Agent use a local OpenAI upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "gpt-5.6-sol",
        "Response from Codex through the local fake provider",
    );
    await using codex = await CodexFixture.create(provider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: codex.environment,
        agentId: "codex",
        agentPath: codex.executable,
        sessionId: "real-codex-local-provider",
        signal,
        title: "Real Codex local provider",
    });
    const observedEvents: unknown[] = [];

    try {
        await runAgentDaemonTurn(journey, {
            onEvent: (event) => {
                observedEvents.push(
                    event instanceof MobiusAgentActivityEvent
                        ? {
                              activityType: event.activityType,
                              kind: event.kind,
                              name: event.name,
                              sequence: event.sequence,
                              status: event.status,
                              title: event.title,
                              toolKind: event.toolKind,
                          }
                        : { type: event?.constructor.name },
                );
            },
        });
        await expectPersistedToolTurn(journey, provider.response);
    } catch (error) {
        process.stderr.write(
            `Codex integration diagnostics:\n${JSON.stringify(
                {
                    daemonOutput: journey.daemon.output,
                    messages: await journey.messages(),
                    observedEvents,
                    providerRequests: provider.diagnostics(),
                    rollout: await codex.rolloutDiagnostics(),
                },
                null,
                2,
            )}\n`,
        );
        throw error;
    }
});
