import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSessionCommand, NativeSessionEntry } from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import { fixture } from "./native-session-fixture.ts";

describe("native session authorization", () => {
    it.each(["Claude Code"] as const)(
        "Given %s has saved conversations across projects, When they are listed and imported, Then pagination includes other directories and imports retain their original project and Mobius identity",
        async (label) => {
            const f = await fixture(label);
            try {
                const outside = join(f.temporary, "outside");
                await mkdir(outside);
                await f.seed("Saved one");
                await f.seed("Saved two");
                await f.seed("Saved three");
                await f.seed("Additional project", [outside]);
                await f.seed("Other project", [], outside);
                const entries: NativeSessionEntry[] = [];
                let cursor: string | null = null;
                do {
                    const page = await f.list(cursor);
                    entries.push(...page.entries);
                    cursor = page.nextCursor;
                } while (cursor !== null);
                expect(entries.map((entry) => entry.title).sort()).toEqual([
                    "Additional project",
                    "Other project",
                    "Saved one",
                    "Saved three",
                    "Saved two",
                ]);
                const entry = entries.find((entry) => entry.title === "Other project");
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                const command = {
                    ...f.identity,
                    action: "import",
                    directoryId: entry.directoryId,
                    entryId: entry.entryId,
                    targetSessionId: "imported",
                } satisfies NativeSessionCommand;
                const first = await f.service.execute(command, new AbortController().signal);
                expect(first).toMatchObject({
                    action: "import",
                    ready: {
                        sessionId: "imported",
                        restored: true,
                        directoryId: entry.directoryId,
                        directoryLabel: entry.directoryLabel,
                        capabilities: {
                            listSessions: true,
                            deleteSession: true,
                            unstableForkSession: true,
                        },
                    },
                });
                expect(
                    await f.service.execute({ ...command, targetSessionId: "duplicate" }, new AbortController().signal),
                ).toMatchObject({ ready: { sessionId: "imported" } });
                await expect(
                    f.service.execute({ ...command, entryId: "forged" }, new AbortController().signal),
                ).rejects.toMatchObject({ code: "native_session_not_found" });
                await expect(f.list("forged-cursor")).rejects.toMatchObject({
                    code: "native_session_cursor_expired",
                });
            } finally {
                await f.close();
            }
        },
    );

    it("Given paginated native sessions, When one is found by its native ID, Then its authorized entry exposes the ID for direct Chat ownership", async () => {
        const f = await fixture("Claude Code");
        try {
            await f.seed("Earlier conversation");
            await f.seed("Another conversation");
            const nativeSessionId = await f.seed("Current handoff conversation");
            const found = await f.service.execute(
                { ...f.identity, action: "find", nativeSessionId },
                new AbortController().signal,
            );
            expect(found).toMatchObject({
                action: "find",
                entry: { title: "Current handoff conversation" },
            });
            expect(found).toMatchObject({ entry: { nativeSessionId } });
            if (found.action !== "find") {
                throw new Error("Expected a native session lookup");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "import",
                        entryId: found.entry.entryId,
                        targetSessionId: "handoff-import",
                    },
                    new AbortController().signal,
                ),
            ).resolves.toMatchObject({
                action: "import",
                ready: { sessionId: "handoff-import" },
            });
        } finally {
            await f.close();
        }
    });

    it("Given a listed session uses a linked directory, When that directory changes before import, Then the local boundary requires a refreshed selection before importing the session", async () => {
        const f = await fixture("Claude Code");
        try {
            const inside = join(f.workspace, "inside");
            const outside = join(f.temporary, "outside");
            const alias = join(f.workspace, "alias");
            await mkdir(inside);
            await mkdir(outside);
            await symlink(inside, alias);
            await f.seed("Moving roots", [alias]);
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await rm(alias);
            await symlink(outside, alias);
            await expect(
                f.service.execute(
                    { ...f.identity, action: "import", entryId: entry.entryId, targetSessionId: "import-target" },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "native_session_target_changed" });
            expect((await readdir(f.native)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
            expect((await f.list()).entries).toEqual([expect.objectContaining({ title: "Moving roots" })]);
        } finally {
            await f.close();
        }
    });

    it("Given an Agent omits native session capabilities, When a remote caller requests its sessions, Then the local boundary rejects the operation", async () => {
        const f = await fixture("Claude Code", "unsupported");
        try {
            const ready = await f.sessions.prepareSession({
                agent: f.agent,
                cwd: f.workspace,
                additionalDirectories: [],
                sessionId: "browser",
                signal: new AbortController().signal,
            });
            expect(ready.capabilities).toMatchObject({
                listSessions: false,
                deleteSession: false,
                unstableForkSession: false,
            });
            await expect(f.list()).rejects.toMatchObject({
                code: "native_session_unsupported",
            });
        } finally {
            await f.close();
        }
    });
});
