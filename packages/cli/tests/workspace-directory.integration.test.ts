import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceDirectoryService } from "../src/authorization/workspace-directory.ts";

describe("authorized workspace directory selection", () => {
  it("Given an approved root, When the browser browses and selects a child directory, Then only canonical in-root directories can be resolved", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-workspace-"),
    );
    const approvedRoot = join(temporaryDirectory, "approved");
    const outside = join(temporaryDirectory, "outside");
    await mkdir(join(approvedRoot, "apps", "web"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(approvedRoot, "escape"));
    const service = new WorkspaceDirectoryService("workspace", approvedRoot);

    try {
      const root = await service.list("workspace", "root");
      expect(root.entries.map((entry) => entry.name)).toEqual(["apps"]);

      const apps = await service.list(
        "workspace",
        root.entries[0]?.directoryId ?? "missing",
      );
      expect(apps.directoryLabel).toContain("apps");
      expect(apps.entries.map((entry) => entry.name)).toEqual(["web"]);

      const selected = await service.resolve(
        "workspace",
        apps.entries[0]?.directoryId ?? "missing",
      );
      expect(selected).toBe(await realpath(join(approvedRoot, "apps", "web")));
      await expect(
        service.resolve("workspace", "dir-Li4vb3V0c2lkZQ"),
      ).rejects.toMatchObject({ code: "local_authorization_failed" });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
