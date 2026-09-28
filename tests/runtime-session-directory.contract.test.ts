import { RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-protocol";
import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";
import { expect, it } from "vitest";
import { startTestPlatform } from "./infra/platform.ts";

it("Given a prompted local conversation, When its Runtime Session directory is loaded, Then the conversation is listed", async () => {
    const cancellation = new AbortController();
    await using platform = await startTestPlatform();
    try {
        const project = await platform.developer.createProject(
            platform.appId,
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Runtime Session directory",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            cancellation.signal,
        );
        const runtime = await platform.connectAgent(project.projectId);
        const sessionId = `session-${crypto.randomUUID()}`;
        await runtime.client.sessions.create(
            {
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 60_000, 10, 1_024),
                runtimeId: runtime.runtimeId,
                sessionId,
                title: "Remembered conversation",
            },
            cancellation.signal,
        );
        await runtime.client.turns.submitToRuntime(
            runtime.runtimeId,
            sessionId,
            {
                additionalDirectoryIds: [],
                agentId: "claude",
                content: "Remember this conversation",
                directoryId: "default",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                images: [],
                resources: [],
            },
            cancellation.signal,
        );

        await expect(
            runtime.client.runtimes.listSessions(runtime.runtimeId, 100, cancellation.signal),
        ).resolves.toEqual([
            expect.objectContaining({
                agentId: "claude",
                directoryId: expect.any(String),
                prompted: true,
                sessionId,
                title: "Remember this conversation",
            }),
        ]);
    } finally {
        cancellation.abort(new Error("Runtime Session directory test completed"));
    }
});
