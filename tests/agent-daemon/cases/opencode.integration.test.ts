import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import {
    MobiusClient,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { OpenCodeFixture } from "../infra/opencode.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

it("Given real OpenCode configured with a local provider, When a prompt crosses the server and daemon protocols, Then OpenCode calls the provider and its ACP response is persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "mobius-test-model",
        "Response from OpenCode through the local fake provider",
    );
    await using openCode = await OpenCodeFixture.create(provider);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using daemon = await startProductionMobiusCli(deployment, pairing, {
        agentEnvironment: openCode.environment,
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
                        agentPath: openCode.executable,
                        agentVersion: expect.any(String),
                        id: "opencode",
                    }),
                ],
                online: true,
                runtimeId: pairing.runtimeId,
            }),
        ]);
        const session = await client.sessions.create(
            {
                agentId: "opencode",
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: "real-opencode-local-provider",
                title: "Real OpenCode local provider",
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
                    idempotencyKey: "real-opencode-local-provider",
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
                response: provider.response,
            },
        ]);
    } finally {
        client.close();
    }
});
