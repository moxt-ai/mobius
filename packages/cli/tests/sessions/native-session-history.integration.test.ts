import { existsSync, watch } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fixture } from "./native-session-fixture.ts";

describe("native session history", () => {
    it("Given Codex already owns a native session writer, When Chat previews that session, Then Runtime reads history without requesting another writer", async () => {
        const f = await fixture("Codex", "exclusive-writer", "assigned", {
            access: () => ({
                kind: "direct",
                read: async () => ({
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: [
                        { role: "user", text: "Read without resuming" },
                        { activities: [], content: [], role: "assistant", text: "Preview available" },
                    ],
                    status: "available",
                    truncated: false,
                }),
            }),
        });
        const signal = new AbortController().signal;
        try {
            const nativeSessionId = await f.seed("Writer-owned Codex session");
            await f.sessions.openNativeSession(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "active-codex-session",
                    signal,
                },
                { kind: "import", nativeSessionId, title: "Writer-owned Codex session" },
            );

            const preview = await f.sessions.previewNativeSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "codex-preview",
                    signal,
                },
                nativeSessionId,
                50,
                null,
            );

            expect(
                preview.events.flatMap((event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toEqual(["Read without resuming", "Preview available"]);
        } finally {
            await f.close();
        }
    });

    it("Given a long Codex conversation is previewed, When Chat pages to older messages, Then Runtime pages the materialized history without reading the source again", async () => {
        let reads = 0;
        const f = await fixture("Codex", "supported", "assigned", {
            access: () => ({
                kind: "direct",
                read: async () => {
                    reads += 1;
                    return {
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                        messages: Array.from({ length: 6 }, (_unused, index) => ({
                            role: "user" as const,
                            text: `Message ${index.toString()}`,
                        })),
                        status: "available",
                        truncated: false,
                    };
                },
            }),
        });
        const options = {
            additionalDirectories: [],
            agent: f.agent,
            cwd: f.workspace,
            sessionId: "codex-paged-preview",
            signal: new AbortController().signal,
        };
        const texts = (page: { readonly events: readonly { readonly type: string }[] }): readonly string[] =>
            page.events.flatMap((event) =>
                event.type === "acp" &&
                "payload" in event &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "content" in event.payload &&
                typeof event.payload.content === "object" &&
                event.payload.content !== null &&
                "text" in event.payload.content &&
                typeof event.payload.content.text === "string"
                    ? [event.payload.content.text]
                    : [],
            );
        try {
            const nativeSessionId = await f.seed("Long Codex session");
            const newest = await f.sessions.previewNativeSessionEventsV2(options, nativeSessionId, 2, null);
            expect(texts(newest)).toEqual(["Message 4", "Message 5"]);
            expect(newest.nextCursor).not.toBeNull();

            const older = await f.sessions.previewNativeSessionEventsV2(options, nativeSessionId, 2, newest.nextCursor);

            expect(texts(older)).toEqual(["Message 2", "Message 3"]);
            expect(reads).toBe(1);
        } finally {
            await f.close();
        }
    });

    it("Given Chat imports a titled Codex conversation, When the imported Chat opens, Then its source title and history remain visible without requesting another writer", async () => {
        const f = await fixture("Codex", "exclusive-writer", "assigned", {
            access: () => ({
                kind: "direct",
                read: async () => ({
                    coveredCommandIds: [],
                    coveredMessageIds: [],
                    messages: [
                        { role: "user", text: "Imported Codex source" },
                        { activities: [], content: [], role: "assistant", text: "Imported Codex response" },
                    ],
                    status: "available",
                    truncated: false,
                }),
            }),
        });
        const signal = new AbortController().signal;
        try {
            await f.seed("Writer-owned Codex session");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const sessionId = "imported-codex-session";
            await f.service.execute(
                { ...f.identity, action: "import", entryId: entry.entryId, targetSessionId: sessionId },
                signal,
            );

            expect(f.sessions.listSessions(10).find((session) => session.sessionId === sessionId)?.title).toBe(
                entry.title,
            );

            const replay = await f.sessions.loadSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toEqual(["Writer-owned Codex session", "Codex turn 1: Writer-owned Codex session"]);
        } finally {
            await f.close();
        }
    });

    it("Given Chat imports a Claude Code conversation, When the imported Chat opens, Then its source history is visible", async () => {
        const f = await fixture("Claude Code", "exclusive-writer");
        const signal = new AbortController().signal;
        try {
            await f.seed("Imported Claude source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const sessionId = "imported-claude-session";
            await f.service.execute(
                { ...f.identity, action: "import", entryId: entry.entryId, targetSessionId: sessionId },
                signal,
            );

            const replay = await f.sessions.loadSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Imported Claude source");
        } finally {
            await f.close();
        }
    });

    it("Given Chat forks a Claude Code conversation, When the forked Chat opens, Then its copied history is visible", async () => {
        const f = await fixture("Claude Code", "exclusive-writer");
        const signal = new AbortController().signal;
        try {
            await f.seed("Forked Claude source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const sessionId = "forked-claude-session";
            await f.service.execute(
                { ...f.identity, action: "fork", entryId: entry.entryId, targetSessionId: sessionId },
                signal,
            );

            const replay = await f.sessions.loadSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId,
                    signal,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Forked Claude source");
        } finally {
            await f.close();
        }
    });

    it("Given ACP replays committed native updates, When Runtime loads V2 source facts, Then every accepted notification is exposed once without V1 activity folding", async () => {
        const f = await fixture("OpenCode");
        try {
            const nativeSessionId = await f.seed("Preserve this update");
            const replay = await f.sessions.previewNativeSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "v2-history-query",
                    signal: new AbortController().signal,
                },
                nativeSessionId,
                50,
                null,
            );

            const updates = replay.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            expect(updates).toMatchObject([
                {
                    content: { text: "Preserve this update", type: "text" },
                    messageId: "user-1",
                    sessionUpdate: "user_message_chunk",
                },
                {
                    content: { text: "Inspecting the workspace", type: "text" },
                    messageId: "reasoning-assistant-1",
                    sessionUpdate: "agent_thought_chunk",
                },
                {
                    sessionUpdate: "tool_call",
                    toolCallId: "tool-assistant-1",
                },
                {
                    sessionUpdate: "tool_call",
                    toolCallId: "error-assistant-1",
                },
                {
                    content: { text: "OpenCode turn 1: Preserve this update", type: "text" },
                    messageId: "assistant-1",
                    sessionUpdate: "agent_message_chunk",
                },
            ]);

            const newestMessage = await f.sessions.previewNativeSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "v2-history-query",
                    signal: new AbortController().signal,
                },
                nativeSessionId,
                4,
                null,
            );
            expect(newestMessage.nextCursor).not.toBeNull();
            expect(
                newestMessage.events.flatMap((event) => (event.type === "acp" ? [event.payload.sessionUpdate] : [])),
            ).toEqual(["agent_thought_chunk", "tool_call", "tool_call", "agent_message_chunk"]);
            const olderMessage = await f.sessions.previewNativeSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "v2-history-query",
                    signal: new AbortController().signal,
                },
                nativeSessionId,
                4,
                newestMessage.nextCursor,
            );
            expect(olderMessage.nextCursor).toBeNull();
            expect([...olderMessage.events, ...newestMessage.events].map(({ payload }) => payload)).toEqual(
                replay.events.map(({ payload }) => payload),
            );
        } finally {
            await f.close();
        }
    });

    it("Given OpenCode emits persisted history only on the first session load, When Chat requests history after preparation, Then Runtime returns messages from that load", async () => {
        const f = await fixture("OpenCode", "replay-history-once");
        const signal = new AbortController().signal;
        try {
            await f.seed("Persisted OpenCode message");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing OpenCode conversation");
            }
            const sessionId = "restored-opencode-session";
            await f.service.execute(
                { ...f.identity, action: "import", entryId: entry.entryId, targetSessionId: sessionId },
                signal,
            );

            const history = await f.sessions.loadSessionHistory({
                additionalDirectories: [],
                agent: f.agent,
                cwd: f.workspace,
                sessionId,
                signal,
            });

            expect(history).toMatchObject({
                status: "available",
                messages: expect.arrayContaining([{ role: "user", text: "Persisted OpenCode message" }]),
            });
        } finally {
            await f.close();
        }
    });

    it("Given two clients request OpenCode history while its first session load is in progress, When that load completes, Then both clients receive the same history", async () => {
        const f = await fixture("OpenCode", "replay-history-once", "native");
        const signal = new AbortController().signal;
        try {
            const sessionId = await f.seed("Shared OpenCode history");
            await writeFile(join(f.native, "pause-load"), "");
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const options = {
                additionalDirectories: [],
                agent: f.agent,
                cwd: f.workspace,
                sessionId,
                signal,
            };
            const first = f.sessions.loadSessionHistory(options);
            await paused.promise;
            const second = f.sessions.loadSessionHistory(options);
            await rm(join(f.native, "pause-load"));

            for (const history of await Promise.all([first, second])) {
                expect(history).toMatchObject({
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Shared OpenCode history" }]),
                });
            }
        } finally {
            await rm(join(f.native, "pause-load"), { force: true });
            await f.close();
        }
    });

    it("Given a saved local conversation, When its history is previewed and then forked, Then only preview returns history and only fork creates a new conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
        const f = await fixture("Claude Code", "exclusive-writer");
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
    it("Given a titled local conversation, When it is forked repeatedly, Then each child receives the next numbered fork title", async () => {
        const f = await fixture("Claude Code");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }

            const first = await f.service.execute(
                { ...f.identity, action: "fork", entryId: entry.entryId, targetSessionId: "first-forked-copy" },
                new AbortController().signal,
            );
            const second = await f.service.execute(
                { ...f.identity, action: "fork", entryId: entry.entryId, targetSessionId: "second-forked-copy" },
                new AbortController().signal,
            );

            expect(first).toMatchObject({ action: "fork", title: "Original context (Fork #1)" });
            expect(second).toMatchObject({ action: "fork", title: "Original context (Fork #2)" });
            expect(f.sessions.listSessions(10).map((session) => session.title)).toEqual(
                expect.arrayContaining(["Original context (Fork #1)", "Original context (Fork #2)"]),
            );
        } finally {
            await f.close();
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
