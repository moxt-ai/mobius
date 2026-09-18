import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import {
    MobiusAgentActivityEvent,
    MobiusClient,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { CodexFixture } from "../infra/codex.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real Codex and codex-acp use a local OpenAI upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "gpt-5.6-sol",
        "Response from Codex through the local fake provider",
    );
    await using codex = await CodexFixture.create(provider);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using daemon = await startProductionMobiusCli(deployment, pairing, {
        agentEnvironment: codex.environment,
    });
    expect(daemon.channelId).toBe(pairing.channelId);

    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
        endpoint: deployment.origin,
        projectId: pairing.projectId,
    });
    const observedEvents: unknown[] = [];
    try {
        await expect(client.runtimes.list(signal)).resolves.toEqual([
            expect.objectContaining({
                agents: [
                    expect.objectContaining({
                        agentPath: codex.executable,
                        agentVersion: expect.any(String),
                        id: "codex",
                    }),
                ],
                online: true,
                runtimeId: pairing.runtimeId,
            }),
        ]);
        const session = await client.sessions.create(
            {
                agentId: "codex",
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: "real-codex-local-provider",
                title: "Real Codex local provider",
            },
            signal,
        );
        const completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
        const subscription = await client.events.subscribe(
            session.sessionId,
            "",
            {
                receive: (event) => {
                    observedEvents.push(
                        event.payload instanceof MobiusAgentActivityEvent
                            ? {
                                  activityType: event.payload.activityType,
                                  kind: event.payload.kind,
                                  name: event.payload.name,
                                  sequence: event.payload.sequence,
                                  status: event.payload.status,
                                  title: event.payload.title,
                                  toolKind: event.payload.toolKind,
                              }
                            : { kind: event.payload.kind, type: event.payload.constructor.name },
                    );
                    if (event.payload instanceof MobiusTurnCompletedEvent) {
                        completed.resolve(event.payload);
                    }
                    if (event.payload instanceof MobiusTurnFailedEvent) {
                        completed.reject(new Error(`${event.payload.code}: ${event.payload.message}`));
                    }
                    return Promise.resolve(true);
                },
            },
            signal,
        );
        try {
            await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Reply using the configured model",
                    idempotencyKey: "real-codex-local-provider",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await completed.promise;
        } finally {
            subscription.close();
            await subscription.completed;
        }

        try {
            await expect
                .poll(
                    async () =>
                        (await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal))
                            .messages,
                    { timeout: 10_000 },
                )
                .toMatchObject([
                    {
                        attempt: { kind: "succeeded" },
                        activities: expect.arrayContaining([
                            expect.objectContaining({
                                activityType: "tool",
                                status: "completed",
                                toolCallId: expect.any(String),
                            }),
                        ]),
                        prompt: "Reply using the configured model",
                        response: expect.stringContaining(provider.response),
                    },
                ]);
        } catch (error) {
            const messages = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal);
            process.stderr.write(
                `Codex integration diagnostics:\n${JSON.stringify(
                    {
                        daemonOutput: daemon.output,
                        messages: messages.messages,
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
    } finally {
        client.close();
    }
});
