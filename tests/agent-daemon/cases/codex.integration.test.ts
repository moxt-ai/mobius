import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import {
    MobiusClient,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { CodexFixture } from "../infra/codex.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real Codex and codex-acp use a local OpenAI upstream, When a prompt crosses the server and daemon protocols, Then the ACP response is persisted", {
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

        const history = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal);
        expect(history.messages).toMatchObject([
            {
                attempt: { kind: "succeeded" },
                prompt: "Reply using the configured model",
                response: expect.stringContaining(provider.response),
            },
        ]);
    } finally {
        client.close();
    }
});
