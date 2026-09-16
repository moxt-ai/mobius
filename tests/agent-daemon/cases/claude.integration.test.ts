import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import {
    MobiusClient,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { ClaudeFixture } from "../infra/claude.ts";
import { FakeAnthropicProvider } from "../providers/anthropic.ts";

it("Given real Claude Code and claude-agent-acp use a local Anthropic upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeAnthropicProvider.start(
        "claude-sonnet-4-6",
        "Response from Claude Code through the local fake provider",
    );
    await using claude = await ClaudeFixture.create(provider);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using daemon = await startProductionMobiusCli(deployment, pairing, {
        agentEnvironment: claude.environment,
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
                        agentPath: claude.executable,
                        agentVersion: expect.any(String),
                        id: "claude",
                    }),
                ],
                online: true,
                runtimeId: pairing.runtimeId,
            }),
        ]);
        const session = await client.sessions.create(
            {
                agentId: "claude",
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: "real-claude-local-provider",
                title: "Real Claude local provider",
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
                    idempotencyKey: "real-claude-local-provider",
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
                        activities: [
                            expect.objectContaining({
                                activityType: "tool",
                                status: "completed",
                                toolCallId: expect.any(String),
                            }),
                        ],
                        prompt: "Reply using the configured model",
                        response: expect.stringContaining(provider.response),
                    },
                ]);
        } catch (error) {
            const messages = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal);
            process.stderr.write(
                `Claude integration diagnostics:\n${JSON.stringify(
                    {
                        daemonOutput: daemon.output,
                        messages: messages.messages,
                        providerRequests: provider.diagnostics(),
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
