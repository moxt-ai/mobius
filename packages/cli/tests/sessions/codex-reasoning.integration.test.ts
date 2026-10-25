import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { LocalAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import type { CodexAppServerClient } from "../../src/acp/harness/codex/app-server-client.ts";
import { reasoningText } from "../../src/acp/harness/codex/items.ts";
import { CodexOwnedAcpAgent } from "../../src/acp/harness/codex/owned-agent.ts";
import type { CodexSettings } from "../../src/acp/harness/codex/settings.ts";
import { readCodexFullHistory } from "../../src/acp/native-history/codex/codex-history.ts";

it("Given Codex streams detailed reasoning and a summary, When Mobius forwards the turn, Then Thinking keeps the reasoning stream", async () => {
    const updates: SessionNotification["update"][] = [];
    let resolveTurnStart: ((value: unknown) => void) | undefined;
    const turnStart = new Promise<unknown>((resolve) => {
        resolveTurnStart = resolve;
    });
    const client = {
        request: async (method: string): Promise<unknown> => (method === "turn/start" ? await turnStart : {}),
    } as unknown as CodexAppServerClient;
    const settings = { turnParameters: () => ({}) } as unknown as CodexSettings;
    const agent = new CodexOwnedAcpAgent({
        client,
        close: async () => {},
        connection: () => null,
        emit: async (update) => {
            updates.push(update);
        },
        settings,
        threadId: () => "thread",
    });

    const running = agent.prompt([], AbortSignal.timeout(10_000));
    resolveTurnStart?.({ turn: { id: "turn", status: "inProgress" } });
    await Promise.resolve();
    await Promise.resolve();
    await agent.onNotification("item/agentMessage/delta", {
        delta: "Progress update",
        itemId: "commentary",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/summaryTextDelta", {
        delta: "Short summary",
        itemId: "reasoning",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/textDelta", {
        delta: "Detailed chain of thought that should be shown",
        itemId: "reasoning",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/completed", {
        item: {
            content: ["Detailed chain of thought that should be shown"],
            id: "reasoning",
            summary: ["Short summary"],
            type: "reasoning",
        },
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/summaryTextDelta", {
        delta: "Summary-only stream",
        itemId: "reasoning-summary-only",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/completed", {
        item: {
            content: ["Detailed reasoning recovered at completion"],
            id: "reasoning-summary-only",
            summary: ["Summary-only stream"],
            type: "reasoning",
        },
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("turn/completed", {
        threadId: "thread",
        turn: { id: "turn", status: "completed" },
    });
    await running;

    expect(
        updates
            .filter((update) => update.sessionUpdate === "agent_thought_chunk")
            .map((update) => (update.content.type === "text" ? update.content.text : "")),
    ).toEqual([
        "Short summary",
        "Detailed chain of thought that should be shown",
        "Summary-only stream",
        "Detailed reasoning recovered at completion",
    ]);
    expect(
        updates
            .filter((update) => update.sessionUpdate === "agent_message_chunk")
            .map((update) => (update.content.type === "text" ? update.content.text : "")),
    ).toEqual(["Progress update"]);
    expect(
        reasoningText({
            content: ["Detailed chain of thought"],
            id: "reasoning-without-summary",
            summary: [],
            type: "reasoning",
        }),
    ).toBe("Detailed chain of thought");
});

it("Given saved Codex history contains commentary and detailed reasoning, When Mobius previews it, Then commentary stays assistant output and detailed reasoning becomes Thinking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-history-summary-"));
    const executable = join(directory, "codex.mjs");
    const nativeSessionId = "native-codex";
    await writeFile(
        executable,
        `#!${process.execPath}
import { createInterface } from "node:readline";

const history = {
    data: [{
        error: null,
        id: "turn-1",
        items: [
            { content: [{ text: "Prompt", type: "text" }], type: "userMessage" },
            { id: "commentary-1", phase: "commentary", text: "Progress update", type: "agentMessage" },
            { content: ["Detailed reasoning"], id: "reasoning-1", summary: ["Short summary"], type: "reasoning" },
            { content: ["Detailed reasoning without summary"], id: "reasoning-2", summary: [], type: "reasoning" },
            { content: [], id: "reasoning-3", summary: ["Summary fallback"], type: "reasoning" },
            { id: "answer-1", phase: "final_answer", text: "Answer", type: "agentMessage" },
        ],
        status: "completed",
    }],
    nextCursor: null,
};

createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.id === 2
        ? { thread: { cwd: process.cwd(), id: ${JSON.stringify(nativeSessionId)} } }
        : request.id >= 3
          ? history
          : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
        { mode: 0o700 },
    );
    const agent = new LocalAgentDefinition("codex", "Codex", executable, []);
    try {
        const snapshot = await readCodexFullHistory(agent, directory, nativeSessionId, AbortSignal.timeout(10_000));
        if (snapshot.history.status !== "available") {
            throw new Error("Expected Codex history to be available");
        }
        expect(snapshot.history.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ activities: [], text: "Progress update" }),
                expect.objectContaining({
                    activities: [expect.objectContaining({ output: "Detailed reasoning" })],
                    text: "",
                }),
                expect.objectContaining({
                    activities: [expect.objectContaining({ output: "Detailed reasoning without summary" })],
                    text: "",
                }),
                expect.objectContaining({
                    activities: [expect.objectContaining({ output: "Summary fallback" })],
                    text: "",
                }),
                expect.objectContaining({ text: "Answer" }),
            ]),
        );
        expect(
            snapshot.history.messages.some(
                (message) =>
                    message.role === "assistant" &&
                    message.activities.some((activity) => activity.output === "Progress update"),
            ),
        ).toBe(false);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
