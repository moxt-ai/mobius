import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceDirectoryService } from "../../src/authorization/workspace-directory.ts";

describe("machine directory selection", () => {
    it("Given a paired machine and a default workspace, When the browser browses Home and selects another project, Then accessible canonical directories are available without granting another workspace", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-workspace-"));
        const defaultWorkspace = join(temporaryDirectory, "default");
        const outside = join(temporaryDirectory, "outside");
        await mkdir(join(defaultWorkspace, "apps", "web"), { recursive: true });
        await mkdir(outside);
        await symlink(outside, join(defaultWorkspace, "escape"));
        const service = new WorkspaceDirectoryService("workspace", defaultWorkspace);
        const signal = new AbortController().signal;

        try {
            expect((await service.list("workspace", "home", signal)).directoryLabel).toBe("~");
            expect(await service.resolve("workspace", "home", signal)).toBe(await realpath(homedir()));
            const listing = await service.list("workspace", "default", signal);
            expect(listing.entries.map((entry) => entry.name)).toEqual(["apps", "escape"]);
            const linked = listing.entries.find((entry) => entry.name === "escape");
            expect(await service.resolve("workspace", linked?.directoryId ?? "missing", signal)).toBe(
                await realpath(outside),
            );

            const apps = await service.list("workspace", listing.entries[0]?.directoryId ?? "missing", signal);
            expect(apps.directoryLabel).toContain("apps");
            expect(apps.entries.map((entry) => entry.name)).toEqual(["web"]);

            const selected = await service.resolve("workspace", apps.entries[0]?.directoryId ?? "missing", signal);
            expect(selected).toBe(await realpath(join(defaultWorkspace, "apps", "web")));
            await expect(service.resolve("another-machine", "home", signal)).rejects.toMatchObject({
                code: "local_authorization_failed",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
