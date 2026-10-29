import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_WORKSPACE_BINDING_ID } from "@moxt-ai/mobius-sdk/protocol";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

for (const client of ["SDK", "legacy HTTP", "HTTP"] as const) {
    it(`Given a new Session, When ${client} creates and prompts it, Then its conversation uses the Runtime title and workspace without enabling Recording`, async () => {
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
            const request = {
                additionalDirectoryIds: [],
                agentId: "claude",
                directoryId: "default",
                runtimeId: runtime.runtimeId,
                sessionId,
            };
            if (client === "SDK") {
                await runtime.client.sessions.create(request, cancellation.signal);
            } else {
                const response = await platform.app.request(
                    new Request(
                        `${platform.baseUrl}/mobius/api/v1/projects/${project.projectId}/runtimes/${runtime.runtimeId}/sessions`,
                        {
                            method: "POST",
                            headers: {
                                authorization: `Bearer ${platform.appCredential}`,
                                "content-type": "application/json",
                            },
                            body: JSON.stringify({
                                ...request,
                                ...(client === "legacy HTTP"
                                    ? { bindingId: "binding_legacy", title: "Legacy title" }
                                    : {}),
                            }),
                            signal: cancellation.signal,
                        },
                    ),
                );
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject({
                    kind: "session.ready",
                    sessionId,
                    agentId: "claude",
                    directoryId: "default",
                });
            }
            await runtime.client.turns.submitToRuntime(
                runtime.runtimeId,
                sessionId,
                {
                    additionalDirectoryIds: [],
                    agentId: "claude",
                    attachments: [],
                    content: "Remember this conversation",
                    directoryId: "default",
                    idempotencyKey: `turn-${crypto.randomUUID()}`,
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
            await expect(
                platform.developer.readProjectRecordingPolicy(project.projectId, cancellation.signal),
            ).resolves.toMatchObject({ effectiveMode: "disabled", inheritedFrom: "system", mode: "inherit" });
        } finally {
            cancellation.abort(new Error("Runtime Session directory test completed"));
        }
    });
}

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

it("Given a deeply nested multibyte project path, When the SDK browses it and runs a conversation, Then directory metadata and native history remain accessible", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobius-long-workspace-"));
    try {
        const path = join(
            root,
            ...Array.from({ length: process.platform === "linux" ? 8 : 3 }, () => "\u00e9".repeat(110)),
        );
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
        if (process.platform === "linux") {
            expect(listing.parentDirectoryId.length).toBeGreaterThan(2048);
        }
        const identity = { additionalDirectoryIds: [], agentId: "claude", directoryId };
        const sessionId = `session-${crypto.randomUUID()}`;
        await runtime.client.sessions.create(
            {
                ...identity,
                bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                runtimeId: runtime.runtimeId,
                sessionId,
                title: "Long workspace conversation",
            },
            signal,
        );
        await runtime.client.turns.submitToRuntime(
            runtime.runtimeId,
            sessionId,
            {
                ...identity,
                content: "Remember the long workspace conversation",
                idempotencyKey: `turn-${crypto.randomUUID()}`,
                attachments: [],
            },
            signal,
        );
        expect(await runtime.client.runtimes.listSessions(runtime.runtimeId, 100, signal)).toContainEqual(
            expect.objectContaining({ sessionId, directoryId, directoryLabel: canonical, prompted: true }),
        );
        const discovery = await runtime.client.runtimes.nativeSessions(
            runtime.runtimeId,
            { ...identity, action: "list", cursor: null, discoveryId: null },
            signal,
        );
        if (discovery.action !== "list" || discovery.entries[0] === undefined) {
            throw new Error("Missing native conversation in the long workspace");
        }
        expect(discovery.entries[0]).toMatchObject({ directoryId, directoryLabel: canonical });
        const events = await runtime.client.sessions.previewRuntimeNativeEvents(
            runtime.runtimeId,
            discovery.entries[0].nativeSessionId,
            identity,
            { cursor: null, eventLimit: 100 },
            signal,
        );
        expect(JSON.stringify(events)).toContain("Remember the long workspace conversation");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
