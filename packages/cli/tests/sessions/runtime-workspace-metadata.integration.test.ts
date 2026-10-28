import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk";
import { expect, it } from "vitest";
import { startTestPlatform } from "../support/platform.ts";

// @no-uc: Performance; validating a directory must not require enumerating its children.
it("describes a selected directory without browsing its children and still rejects unavailable directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "mobius-workspace-metadata-"));
    try {
        await mkdir(join(root, "child"));
        const canonical = await realpath(root);
        const directoryId = `path-${Buffer.from(canonical).toString("base64url")}`;
        await using platform = await startTestPlatform();
        const signal = AbortSignal.timeout(30_000);
        const project = await platform.developer.createProject(
            platform.appId,
            {
                clientReference: `client-${crypto.randomUUID()}`,
                displayName: "Directory metadata",
                idempotencyKey: `project-${crypto.randomUUID()}`,
                locationHint: "wnam",
            },
            signal,
        );
        const runtime = await platform.connectAgent(project.projectId);
        const listing = await runtime.client.runtimes.listWorkspace(runtime.runtimeId, directoryId, signal);
        expect(listing.entries.map((entry) => entry.name)).toContain("child");

        const invalid = await fetch(
            `${platform.baseUrl}${MOBIUS_API_PREFIX}/v1/projects/${project.projectId}/runtimes/${runtime.runtimeId}/workspace`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${platform.appCredential}`, "content-type": "application/json" },
                body: JSON.stringify({ directoryId, view: "children" }),
                signal,
            },
        );
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

        // Directory lookup/stat remains permitted, while readdir is denied for ordinary users.
        // The returned metadata contract is the same when a privileged test user ignores chmod.
        await chmod(root, 0o111);
        await expect(
            runtime.client.runtimes.describeWorkspace(runtime.runtimeId, directoryId, signal),
        ).resolves.toStrictEqual({ directoryId, directoryLabel: listing.directoryLabel });
        const missing = `path-${Buffer.from(join(canonical, "missing")).toString("base64url")}`;
        await expect(
            runtime.client.runtimes.describeWorkspace(runtime.runtimeId, missing, signal),
        ).rejects.toMatchObject({ code: "local_authorization_failed" });
    } finally {
        await chmod(root, 0o755);
        await rm(root, { recursive: true, force: true });
    }
});
