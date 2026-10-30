import { MobiusApiError } from "@moxt-ai/mobius-sdk";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

it("Given two clients holding one configuration revision, When they edit concurrently, Then only one edit commits and a stale retry cannot overwrite it", async () => {
    const cancellation = new AbortController();
    await using platform = await startTestPlatform();
    try {
        const project = await platform.developer.createProject(
            platform.appId,
            {
                clientReference: crypto.randomUUID(),
                displayName: "Session configuration authority",
                idempotencyKey: crypto.randomUUID(),
                locationHint: "wnam",
            },
            cancellation.signal,
        );
        const sessionId = crypto.randomUUID();
        const runtime = await platform.connectAgent(project.projectId, undefined, new Set([sessionId]));
        const ready = await runtime.client.sessions.create(
            {
                additionalDirectoryIds: [],
                agentId: "claude",
                directoryId: "default",
                runtimeId: runtime.runtimeId,
                sessionId,
            },
            cancellation.signal,
        );
        expect(ready.configurationRevision).toEqual(expect.any(String));
        const edit = {
            additionalDirectoryIds: [],
            agentId: "claude",
            booleanValue: false,
            configId: "model",
            directoryId: "default",
            expectedConfigurationRevision: ready.configurationRevision,
            value: "test-large",
            valueType: "select" as const,
        };
        const results = await Promise.allSettled([
            runtime.client.sessions.updateConfiguration(runtime.runtimeId, ready.sessionId, edit, cancellation.signal),
            runtime.client.sessions.updateConfiguration(
                runtime.runtimeId,
                ready.sessionId,
                { ...edit, value: "test-small" },
                cancellation.signal,
            ),
        ]);
        const accepted = results.filter((result) => result.status === "fulfilled");
        expect(accepted).toHaveLength(1);
        const rejected = results.filter((result) => result.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(MobiusApiError);
        expect(rejected[0]?.reason).toMatchObject({ code: "session_configuration_conflict", status: 409 });
        const committed = accepted[0];
        if (committed === undefined) {
            throw new Error("One configuration edit must commit");
        }
        expect(committed.value.configurationRevision).not.toBe(ready.configurationRevision);
        await expect(
            runtime.client.sessions.updateConfiguration(runtime.runtimeId, ready.sessionId, edit, cancellation.signal),
        ).rejects.toMatchObject({ code: "session_configuration_conflict", status: 409 });
        const current = await runtime.client.sessions.readConfiguration(
            runtime.runtimeId,
            ready.sessionId,
            cancellation.signal,
        );
        expect(current.configOptions).toEqual(committed.value.configOptions);
        expect(current.configurationRevision).toBe(committed.value.configurationRevision);
    } finally {
        cancellation.abort();
    }
});
