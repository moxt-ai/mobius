import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readCodexFullHistory } from "../../../packages/cli/src/native-sessions/codex-history.ts";
import { codexFixture } from "../infra/codex-native.ts";

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
            AbortSignal.timeout(30_000),
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
        const preview = await f.service.execute(
            { ...f.identity, action: "preview", entryId: entry.entryId },
            AbortSignal.timeout(30_000),
        );
        expect(preview).toMatchObject({ action: "preview", history: { status: "available" } });
        const { history } = await readCodexFullHistory(f.agent, f.workspace, id, AbortSignal.timeout(30_000));
        expect(history).toMatchObject({ status: "available", truncated: false });
        if (history.status !== "available") {
            throw new Error("Missing native history");
        }
        expect(history.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(
            Array.from({ length: 15 }, (_, index) => `Question ${index + 1}`),
        );
        await f.prompt(id, "Continue after history preview");
        const resumed = await readCodexFullHistory(f.agent, f.workspace, id, AbortSignal.timeout(30_000));
        expect(resumed.history).toMatchObject({
            status: "available",
            messages: expect.arrayContaining([
                expect.objectContaining({ role: "user", text: "Continue after history preview" }),
            ]),
        });
    } finally {
        await f.close();
    }
});

it("Given Codex saved tools and a reply exceeding the history budget, When history is opened, Then truncation is disclosed and the tool activities survive", async () => {
    const f = await codexFixture("native", "Large reply ".repeat(30_000));
    try {
        const id = await f.seed("Use two shell tools successfully, then reply");
        const { history } = await readCodexFullHistory(f.agent, f.workspace, id, AbortSignal.timeout(30_000));
        expect(history).toMatchObject({ status: "available", truncated: true });
        if (history.status !== "available") {
            throw new Error("Missing rich history");
        }
        const assistants = history.messages.filter((message) => message.role === "assistant");
        const tools = assistants
            .flatMap((message) => message.activities)
            .filter((activity) => activity.activityType === "tool");
        expect(tools.length).toBeGreaterThanOrEqual(2);
        expect(assistants.some((message) => message.text.includes("Large reply"))).toBe(true);
        expect(JSON.stringify(history).length).toBeLessThan(300_000);
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
        const { history } = await readCodexFullHistory(f.agent, f.workspace, id, AbortSignal.timeout(30_000));
        if (history.status !== "available") {
            throw new Error("Missing patch history");
        }
        const changeIndex = history.messages.findIndex(
            (message) =>
                message.role === "assistant" &&
                message.activities.some(
                    (activity) => activity.activityType === "tool" && JSON.stringify(activity).includes("result.txt"),
                ),
        );
        const answerIndex = history.messages.findIndex(
            (message) => message.role === "assistant" && message.text.includes("PATCH_REPLY"),
        );
        expect(changeIndex).toBeGreaterThanOrEqual(0);
        expect(answerIndex).toBeGreaterThan(changeIndex);
    } finally {
        await f.close();
    }
});
