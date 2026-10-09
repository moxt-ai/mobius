import { existsSync, watch } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fixture } from "./native-session-fixture.ts";

describe("native session history", () => {
    // Keep distinct native identity/history paths; Pi uses the same ACP fixture path as Claude.
    it.each(["Claude Code", "OpenCode"])(
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
                    sessionUpdate: "tool_call_update",
                    toolCallId: "tool-assistant-1",
                },
                {
                    sessionUpdate: "tool_call",
                    toolCallId: "error-assistant-1",
                },
                {
                    sessionUpdate: "tool_call_update",
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
                6,
                null,
            );
            expect(newestMessage.nextCursor).not.toBeNull();
            expect(
                newestMessage.events.flatMap((event) => (event.type === "acp" ? [event.payload.sessionUpdate] : [])),
            ).toEqual([
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "tool_call",
                "tool_call_update",
                "agent_message_chunk",
            ]);
            const olderMessage = await f.sessions.previewNativeSessionEventsV2(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: "v2-history-query",
                    signal: new AbortController().signal,
                },
                nativeSessionId,
                6,
                newestMessage.nextCursor,
            );
            expect(olderMessage.nextCursor).toBeNull();
            expect([...olderMessage.events, ...newestMessage.events]).toEqual(replay.events);
        } finally {
            await f.close();
        }
    });

    it("Given a long OpenCode Session, When Runtime previews or loads its native messages, Then both return the latest 50 messages", async () => {
        const f = await fixture("OpenCode");
        const sessionId = "long-working-session";
        try {
            for (let index = 1; index <= 55; index += 1) {
                await f.sessions.runPrompt({
                    additionalDirectories: [],
                    agent: f.agent,
                    commandId: `command-${index.toString()}`,
                    cwd: f.workspace,
                    images: [],
                    onActivity: async () => {},
                    onText: async () => {},
                    prompt: `Question ${index.toString()}`,
                    resources: [],
                    sessionId,
                    signal: new AbortController().signal,
                });
            }

            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing OpenCode conversation");
            }
            const preview = await f.service.execute(
                { ...f.identity, action: "preview", entryId: entry.entryId },
                new AbortController().signal,
            );
            const loaded = await f.sessions.loadSessionHistory({
                additionalDirectories: [],
                agent: f.agent,
                cwd: f.workspace,
                sessionId,
                signal: new AbortController().signal,
            });

            for (const history of [preview.action === "preview" ? preview.history : null, loaded]) {
                expect(history).toMatchObject({
                    status: "available",
                    messages: expect.arrayContaining([
                        { role: "user", text: "Question 31" },
                        { role: "user", text: "Question 55" },
                    ]),
                    truncated: true,
                });
                if (history?.status !== "available") {
                    throw new Error("Expected OpenCode native messages");
                }
                expect(history.messages).toHaveLength(50);
                expect(history.messages).not.toContainEqual({ role: "user", text: "Question 30" });
            }
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
