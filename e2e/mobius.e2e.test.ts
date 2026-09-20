import { expect, it } from "vitest";
import {
    MobiusAvailableToolCallDetail,
    MobiusClient,
    MobiusPresentAttemptSummary,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    StaticMobiusCredentialProvider,
} from "../packages/mobius-sdk/src/server.ts";
import { startFakeAgentDaemon, startStandaloneDeployment } from "./support/standalone.ts";

it("Given a Standalone deployment and fake Agent-daemon, When a developer pairs a Runtime and submits turns, Then responses, pulled images, and history remain available", {
    timeout: 90_000,
}, async () => {
    const signal = AbortSignal.timeout(80_000);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using runtime = await startFakeAgentDaemon(deployment, pairing, signal);

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
                    content: "generate local image",
                    idempotencyKey: "generate-image",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await Promise.race([completed.promise, runtime.failure]);

            const firstPage = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 100 }, signal);
            expect(firstPage.messages).toHaveLength(1);
            const firstMessage = firstPage.messages[0];
            expect(firstMessage).toMatchObject({
                prompt: "generate local image",
                response: "Codex turn 1: generate local image",
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
                    typeof Reflect.get(entry, "uri") === "string",
            );
            expect(image).toMatchObject({
                type: "image",
                mimeType: "image/png",
                artifactId: "",
                uri: expect.any(String),
            });
            const uri = image === undefined ? "" : String(Reflect.get(image, "uri"));
            const file = await client.sessions.readFile(session.sessionId, uri, signal);
            expect(file.mediaType).toBe("image/png");
            expect(file.bytes.subarray(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));

            completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
            await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "continue conversation",
                    idempotencyKey: "continue-conversation",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await Promise.race([completed.promise, runtime.failure]);

            const history = await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 100 }, signal);
            expect(history.messages).toMatchObject([
                { prompt: "continue conversation", response: "Codex turn 2: continue conversation" },
                { prompt: "generate local image", response: "Codex turn 1: generate local image" },
            ]);
        } finally {
            subscription.close();
            await subscription.completed;
        }
    } finally {
        client.close();
    }
});
