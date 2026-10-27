import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { harnessAdapters } from "../../src/acp/adapter/registry.ts";
import { codexFixture } from "../support/agents/codex-native.ts";
import { previewCodexHistory } from "../support/codex-history-preview.ts";

it("Given a saved Codex conversation with an active writer, When it is previewed, Then history keeps the harness message identities and the writer can continue", async () => {
    const f = await codexFixture("native", "PREVIEW_REPLY", {}, harnessAdapters);
    try {
        const id = await f.seed("Preview this conversation");
        const options = {
            agent: f.agent,
            cwd: f.workspace,
            additionalDirectories: [],
            sessionId: "preview",
            signal: AbortSignal.timeout(30_000),
        };
        const page = await f.sessions.previewNativeSessionEvents(options, id, 100, null);
        const messages = page.events.flatMap((event) =>
            event.type === "acp" &&
            (event.payload.sessionUpdate === "user_message_chunk" ||
                event.payload.sessionUpdate === "agent_message_chunk")
                ? [event.payload]
                : [],
        );
        expect(messages).toContainEqual(
            expect.objectContaining({ content: { type: "text", text: "Preview this conversation" } }),
        );
        expect(messages.length).toBeGreaterThanOrEqual(2);
        const newest = await f.sessions.previewNativeSessionEvents(options, id, 1, null);
        expect(newest.nextCursor).not.toBeNull();
        const older = await f.sessions.previewNativeSessionEvents(options, id, 1, newest.nextCursor);
        expect([...older.events, ...newest.events].map((event) => event.eventId)).toEqual(
            page.events.slice(-2).map((event) => event.eventId),
        );
        const live = await f.sessions.loadSessionEvents({ ...options, sessionId: id }, 100, null);
        const liveMessageIds = live.events.flatMap((event) =>
            event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk"
                ? [event.payload.messageId]
                : [],
        );
        expect(liveMessageIds.length).toBeGreaterThan(0);
        expect(
            messages
                .filter((message) => message.sessionUpdate === "agent_message_chunk")
                .map((message) => message.messageId),
        ).toEqual([...new Set(liveMessageIds)]);
        await f.prompt(id, "Continue after preview");
        const continued = await f.sessions.previewNativeSessionEvents(options, id, 100, null);
        expect(continued.events).toContainEqual(
            expect.objectContaining({
                type: "acp",
                payload: expect.objectContaining({ content: { type: "text", text: "Continue after preview" } }),
            }),
        );
    } finally {
        await f.close();
    }
});

it("Given saved Codex threads, When its directory is listed through the in-process Agent, Then every thread opens without a synthesized submitted-prompt echo", async () => {
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
        const opened = await f.service.execute(
            { ...f.identity, action: "import", entryId: entry.entryId, targetSessionId: "opened-codex-conversation" },
            AbortSignal.timeout(30_000),
        );
        expect(opened.action).toBe("import");
        if (opened.action !== "import") {
            throw new Error("Expected an imported conversation");
        }
        const replay = await f.sessions.loadSessionEvents(
            {
                agent: f.agent,
                cwd: f.workspace,
                additionalDirectories: [],
                sessionId: opened.ready.sessionId,
                signal: AbortSignal.timeout(30_000),
            },
            50,
            null,
        );
        const updates = replay.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
        expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([
            expect.objectContaining({
                messageId: expect.any(String),
                content: { type: "text", text: "Thread from the Codex CLI" },
            }),
        ]);
        expect(updates).toContainEqual(
            expect.objectContaining({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "REAL_CODEX_REPLY: plain response" },
            }),
        );
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

it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
    "Given Runtime uses native Session identities, When Chat requests %s with an assigned destination, Then Codex opens the selected source without returning native history",
    async (action) => {
        const f = await codexFixture("native");
        try {
            const sourceId = await f.seed("Selected source conversation");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const targetSessionId = crypto.randomUUID();
            const result = await f.service.execute(
                {
                    ...f.identity,
                    action,
                    entryId: entry.entryId,
                    targetSessionId,
                },
                AbortSignal.timeout(30_000),
            );
            expect(result).toMatchObject({
                action,
                ready: { sessionId: action === "import" ? sourceId : targetSessionId },
            });
            expect("history" in result).toBe(false);
        } finally {
            await f.close();
        }
    },
);

it("Given an open Codex conversation with fifteen turns, When history is read while the writer stays open, Then full history reaches the first turn and the writer can continue", async () => {
    const f = await codexFixture("native");
    try {
        const id = await f.seed("Question 1");
        for (let turn = 2; turn <= 15; turn++) {
            await f.prompt(id, `Question ${turn}`);
        }
        const entry = (await f.list()).entries[0];
        if (entry === undefined) {
            throw new Error("Missing native conversation");
        }
        const history = await previewCodexHistory(f.agent, f.workspace, id);
        expect(history.truncated).toBe(false);
        expect(
            history.events.flatMap((event) =>
                event.type === "acp" &&
                event.payload.sessionUpdate === "user_message_chunk" &&
                event.payload.content.type === "text"
                    ? [event.payload.content.text]
                    : [],
            ),
        ).toEqual(Array.from({ length: 15 }, (_, index) => `Question ${index + 1}`));
        await f.prompt(id, "Continue after history preview");
        const resumed = await previewCodexHistory(f.agent, f.workspace, id);
        expect(resumed.events).toContainEqual(
            expect.objectContaining({
                type: "acp",
                payload: expect.objectContaining({
                    sessionUpdate: "user_message_chunk",
                    content: { type: "text", text: "Continue after history preview" },
                }),
            }),
        );
    } finally {
        await f.close();
    }
});

it("Given Codex saved tools and a large reply, When history is previewed, Then the complete reply and tool activities remain available as when opened", async () => {
    const answer = "Large reply ".repeat(30_000);
    const f = await codexFixture("native", answer);
    try {
        const id = await f.seed("Use two shell tools successfully, then reply");
        const history = await previewCodexHistory(f.agent, f.workspace, id);
        expect(history.truncated).toBe(false);
        const updates = history.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
        const tools = updates.filter((update) => update.sessionUpdate === "tool_call");
        expect(tools.length).toBeGreaterThanOrEqual(2);
        expect(
            updates.some(
                (update) =>
                    update.sessionUpdate === "agent_message_chunk" &&
                    update.content.type === "text" &&
                    update.content.text.includes(answer),
            ),
        ).toBe(true);
    } finally {
        await f.close();
    }
});

it("Given real Codex applies a patch, When saved history is read, Then the file change precedes the final reply", async () => {
    const f = await codexFixture("native", "PATCH_REPLY", {
        patch: "*** Begin Patch\n*** Add File: result.txt\n+created by Codex\n*** End Patch",
    });
    try {
        const id = await f.seed("Use a tool to create the requested file");
        expect(await readFile(join(f.workspace, "result.txt"), "utf8")).toBe("created by Codex\n");
        const history = await previewCodexHistory(f.agent, f.workspace, id);
        const updates = history.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
        const changeIndex = updates.findIndex(
            (update) => update.sessionUpdate === "tool_call" && JSON.stringify(update).includes("result.txt"),
        );
        const answerIndex = updates.findIndex(
            (update) =>
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text" &&
                update.content.text.includes("PATCH_REPLY"),
        );
        expect(changeIndex).toBeGreaterThanOrEqual(0);
        expect(answerIndex).toBeGreaterThan(changeIndex);
    } finally {
        await f.close();
    }
});
