import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexFixture } from "./codex-native-fixture.ts";

import { fixture } from "./native-session-fixture.ts";

describe("native session history", () => {
    it.each(["Claude Code", "OpenCode", "Pi"])(
        "Given a saved %s conversation, When Chat opens its history, Then Runtime returns the native messages",
        async (agentName) => {
            const f = await fixture(agentName);
            try {
                await f.seed("Earlier message");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing Claude Code conversation");
                }
                const result = await f.service.execute(
                    { ...f.identity, action: "history", entryId: entry.entryId },
                    new AbortController().signal,
                );
                expect(result).toMatchObject({
                    action: "history",
                    history: {
                        status: "available",
                        messages: expect.arrayContaining([{ role: "user", text: "Earlier message" }]),
                    },
                });
            } finally {
                await f.close();
            }
        },
    );

    it("Given saved Codex threads, When its directory is listed through the in-process Agent, Then every thread becomes an authorized entry whose history previews", async () => {
        const f = await codexFixture();
        try {
            await f.seed("Thread from the Codex CLI");
            const result = await f.list();
            expect(result.capabilities.listSessions).toBe(true);
            expect(result.nextCursor).toBeNull();
            const entry = result.entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            expect(entry.title).toBe("Thread from the Codex CLI");
            expect(typeof entry.updatedAt).toBe("string");
            const preview = await f.service.execute(
                { ...f.identity, action: "preview", entryId: entry.entryId },
                new AbortController().signal,
            );
            expect(preview).toMatchObject({
                action: "preview",
                reason: "requested",
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Thread from the Codex CLI" }]),
                },
            });
        } finally {
            await f.close();
        }
    });

    it("Given a Codex thread longer than one preview page, When Chat reads its native history, Then older turns are returned from the Runtime", async () => {
        const f = await codexFixture();
        try {
            const history = Array.from({ length: 15 }, (_, index) => [
                { role: "user", text: `Question ${index + 1}` },
                { role: "assistant", text: `Answer ${index + 1}` },
            ]).flat();
            await writeFile(
                join(f.native, `${encodeURIComponent(crypto.randomUUID())}.json`),
                JSON.stringify({ cwd: f.workspace, title: "Long Codex conversation", history }),
            );
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const result = await f.service.execute(
                { ...f.identity, action: "history", entryId: entry.entryId },
                new AbortController().signal,
            );
            expect(result).toMatchObject({
                action: "history",
                history: {
                    status: "available",
                    messages: expect.arrayContaining([
                        { role: "user", text: "Question 1" },
                        { role: "user", text: "Question 15" },
                    ]),
                },
            });
        } finally {
            await f.close();
        }
    });

    it("Given a saved Codex thread with a long preview, When its directory is listed, Then the thread has a bounded title", async () => {
        const f = await codexFixture();
        try {
            const preview = "Long Codex preview ".repeat(30);
            await f.seed(preview);

            const result = await f.list();

            expect(result.entries).toHaveLength(1);
            expect(result.entries[0]?.title).toBe(preview.slice(0, 500));
        } finally {
            await f.close();
        }
    });

    it("Given a saved local conversation, When its history is previewed and then forked, Then only preview returns history and only fork creates a new conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
        const f = await fixture("Codex", "exclusive-writer");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const files = await readdir(f.native);
            const source = files.find((file) => file.endsWith(".json"));
            if (source === undefined) {
                throw new Error("Missing saved native conversation");
            }
            const original = await readFile(join(f.native, source), "utf8");
            const preview = await f.service.execute(
                { ...f.identity, action: "preview", entryId: entry.entryId },
                new AbortController().signal,
            );
            expect(preview).toMatchObject({
                action: "preview",
                reason: "requested",
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Original context" }]),
                },
            });
            expect(await readdir(f.native)).toEqual(files);
            expect(await readFile(join(f.native, source), "utf8")).toBe(original);
            const fork = await f.service.execute(
                {
                    ...f.identity,
                    action: "fork",
                    entryId: entry.entryId,
                    targetSessionId: "forked-copy",
                },
                new AbortController().signal,
            );
            expect(fork).toMatchObject({
                action: "fork",
                ready: { sessionId: "forked-copy" },
            });
            expect((await f.list()).entries).toHaveLength(2);
            expect(await readFile(join(f.native, source), "utf8")).toBe(original);
        } finally {
            await f.close();
            vi.useRealTimers();
        }
    });
    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given native history loading is unavailable, When a saved conversation is %sed, Then Runtime opens it without loading history",
        async (action) => {
            const f = await fixture("Claude Code");
            try {
                await f.seed("Private native history");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                await writeFile(join(f.native, "pause-load"), "");

                const result = await f.service.execute(
                    {
                        ...f.identity,
                        action,
                        entryId: entry.entryId,
                        targetSessionId: `${action}-without-history`,
                    },
                    new AbortController().signal,
                );
                expect(result).toMatchObject({
                    action,
                    ready: { sessionId: `${action}-without-history` },
                });
                expect("history" in result).toBe(false);
                expect(await readdir(f.native)).not.toContain("load-paused");
            } finally {
                await f.close();
            }
        },
    );
});
