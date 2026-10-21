import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobiusRecordingPolicy } from "@moxt-ai/mobius-sdk";
import { RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-sdk/protocol";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

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
                status: { kind: "idle" },
                title: "Remember this conversation",
            }),
        ]);
    } finally {
        cancellation.abort(new Error("Runtime Session directory test completed"));
    }
});

it("Given long ASCII and multibyte directory references, When the SDK browses them, Then the local filesystem remains the authority for directory availability", async () => {
    await using platform = await startTestPlatform();
    const signal = AbortSignal.timeout(30_000);
    const project = await platform.developer.createProject(
        platform.appId,
        {
            clientReference: `client-${crypto.randomUUID()}`,
            displayName: "Long directory references",
            idempotencyKey: `project-${crypto.randomUUID()}`,
            locationHint: "wnam",
        },
        signal,
    );
    const runtime = await platform.connectAgent(project.projectId);
    for (const segment of ["a".repeat(220), "\u00e9".repeat(110)]) {
        const path = join(tmpdir(), `missing-${crypto.randomUUID()}`, ...Array.from({ length: 8 }, () => segment));
        const directoryId = `path-${Buffer.from(path).toString("base64url")}`;
        expect(directoryId.length).toBeGreaterThan(2048);
        await expect(
            runtime.client.runtimes.listWorkspace(runtime.runtimeId, directoryId, signal),
        ).rejects.toMatchObject({
            code: "local_authorization_failed",
            message: "This directory is missing or unavailable to your user account",
        });
    }
});

it.runIf(process.platform === "linux")(
    "Given a real project path longer than 1533 UTF-8 bytes, When the SDK browses it, Then the daemon returns its canonical directory and parent references",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "mobius-long-workspace-"));
        try {
            const path = join(root, ...Array.from({ length: 8 }, () => "\u00e9".repeat(110)));
            await mkdir(path, { recursive: true });
            const canonical = await realpath(path);
            await using platform = await startTestPlatform();
            const signal = AbortSignal.timeout(30_000);
            const project = await platform.developer.createProject(
                platform.appId,
                {
                    clientReference: `client-${crypto.randomUUID()}`,
                    displayName: "Long project",
                    idempotencyKey: `project-${crypto.randomUUID()}`,
                    locationHint: "wnam",
                },
                signal,
            );
            const runtime = await platform.connectAgent(project.projectId);
            const directoryId = `path-${Buffer.from(canonical).toString("base64url")}`;
            const listing = await runtime.client.runtimes.listWorkspace(runtime.runtimeId, directoryId, signal);
            expect(listing.directoryId).toBe(directoryId);
            expect(listing.directoryLabel).toBe(canonical);
            expect(listing.parentDirectoryId.length).toBeGreaterThan(2048);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
