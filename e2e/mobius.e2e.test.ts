import { expect, it } from "vitest";
import {
    MobiusAvailableToolCallDetail,
    MobiusClient,
    MobiusPresentAttemptSummary,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    StaticMobiusCredentialProvider,
} from "../packages/mobius-sdk/src/server.ts";
import { startProductionMobiusCli, startStandaloneDeployment } from "./support/standalone.ts";

it("Given a Standalone deployment and local Agent, When a developer pairs the production CLI and submits turns before and after restarting it, Then responses, generated images, and history remain available", {
    timeout: 90_000,
}, async () => {
    const signal = AbortSignal.timeout(80_000);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using runtime = await startProductionMobiusCli(deployment, pairing);

    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
        endpoint: deployment.origin,
        projectId: pairing.projectId,
    });
    try {
        await expect(client.runtimes.list(signal)).resolves.toEqual([
            expect.objectContaining({
                agents: [expect.objectContaining({ id: "codex" })],
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
                sessionId: "critical-journey",
                title: "Critical journey",
            },
            signal,
        );
        let completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
        const subscription = await client.events.subscribe(
            session.sessionId,
            "",
            {
                receive: (event) => {
                    if (
                        event.payload instanceof MobiusTurnCompletedEvent &&
                        event.payload.sessionId === session.sessionId
                    ) {
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
                    content: "generate inline image",
                    idempotencyKey: "generate-image",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await completed.promise;

            const firstPage = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 100 }, signal);
            expect(firstPage.messages).toHaveLength(1);
            const firstMessage = firstPage.messages[0];
            expect(firstMessage).toMatchObject({
                prompt: "generate inline image",
                response: "Codex turn 1: generate inline image",
                attempt: { kind: "succeeded" },
            });
            expect(firstMessage?.attempt).toBeInstanceOf(MobiusPresentAttemptSummary);
            if (firstMessage === undefined || !(firstMessage.attempt instanceof MobiusPresentAttemptSummary)) {
                throw new Error("The completed turn has no production Attempt");
            }
            const tool = firstMessage.activities.find((activity) => activity.activityType === "tool");
            if (tool === undefined) {
                throw new Error("The completed turn has no Agent tool activity");
            }
            const detail = await client.toolCalls.readDetail(
                session.sessionId,
                firstMessage.attempt.attemptId,
                tool.toolCallId,
                signal,
            );
            expect(detail).toBeInstanceOf(MobiusAvailableToolCallDetail);
            if (!(detail instanceof MobiusAvailableToolCallDetail)) {
                throw new Error("The Agent tool detail is unavailable");
            }
            const image = detail.content.find(
                (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    Reflect.get(entry, "type") === "image" &&
                    typeof Reflect.get(entry, "artifactId") === "string",
            );
            expect(image).toMatchObject({ type: "image", mimeType: "image/png", artifactId: expect.any(String) });
            const artifactId = image === undefined ? "" : String(Reflect.get(image, "artifactId"));
            const downloaded = await client.artifacts.download(session.sessionId, artifactId, signal);
            expect(downloaded.artifact).toMatchObject({ mediaType: "image/png", state: "available" });
            expect(downloaded.bytes.subarray(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));

            await runtime.restartFromSavedChannel();
            completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
            await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "continue after restart",
                    idempotencyKey: "continue-after-restart",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await completed.promise;

            const history = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 100 }, signal);
            expect(history.messages).toMatchObject([
                { prompt: "continue after restart", response: "Codex turn 2: continue after restart" },
                { prompt: "generate inline image", response: "Codex turn 1: generate inline image" },
            ]);
        } finally {
            subscription.close();
            await subscription.completed;
        }
    } finally {
        client.close();
    }
});
