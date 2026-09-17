import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import {
    MobiusClient,
    MobiusPermissionResponseRequest,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { CopilotFixture } from "../infra/copilot.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

async function waitForTurn<T>(turn: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            turn,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Timed out waiting for the Copilot turn to finish")),
                    40_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

it("Given real GitHub Copilot CLI uses a local OpenAI upstream, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using provider = await FakeOpenAiProvider.start(
        "gpt-4.1",
        "Response from GitHub Copilot CLI through the local fake provider",
    );
    await using copilot = await CopilotFixture.create(provider);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using daemon = await startProductionMobiusCli(deployment, pairing, {
        agentEnvironment: copilot.environment,
    });
    expect(daemon.channelId).toBe(pairing.channelId);

    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
        endpoint: deployment.origin,
        projectId: pairing.projectId,
    });
    let sessionId: string | undefined;
    try {
        await expect(client.runtimes.list(signal)).resolves.toEqual([
            expect.objectContaining({
                agents: [
                    expect.objectContaining({
                        agentPath: copilot.executable,
                        agentVersion: expect.any(String),
                        id: "github-copilot-cli",
                    }),
                ],
                online: true,
                runtimeId: pairing.runtimeId,
            }),
        ]);
        const session = await client.sessions.create(
            {
                agentId: "github-copilot-cli",
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: "real-copilot-local-provider",
                title: "Real Copilot local provider",
            },
            signal,
        );
        sessionId = session.sessionId;
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
                    idempotencyKey: "real-copilot-local-provider",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await expect
                .poll(async () => (await client.interactions.listPending(session.sessionId, signal)).length, {
                    timeout: 20_000,
                })
                .toBe(1);
            const [permission] = await client.interactions.listPending(session.sessionId, signal);
            if (permission?.request.kind !== "permission") {
                throw new Error("GitHub Copilot CLI did not request tool permission");
            }
            const allow = permission.request.options.find((option) => option.kind === "allow_once");
            if (allow === undefined) {
                throw new Error("GitHub Copilot CLI did not offer one-time tool permission");
            }
            await client.interactions.respond(
                session.sessionId,
                permission.interactionId,
                new MobiusPermissionResponseRequest("agent-daemon-e2e", "selected", allow.optionId),
                signal,
            );
            await waitForTurn(completed.promise);
        } finally {
            subscription.close();
            await subscription.completed;
        }

        await expect
            .poll(
                async () =>
                    (await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal)).messages,
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
        const messages =
            sessionId === undefined
                ? []
                : (await client.sessions.readMessages(sessionId, { cursor: "", limit: 10 }, AbortSignal.timeout(5_000)))
                      .messages;
        process.stderr.write(
            `GitHub Copilot CLI integration diagnostics:\n${JSON.stringify(
                {
                    daemonOutput: daemon.output,
                    messages,
                    providerRequests: provider.diagnostics(),
                },
                null,
                2,
            )}\n`,
        );
        throw error;
    } finally {
        client.close();
    }
});
