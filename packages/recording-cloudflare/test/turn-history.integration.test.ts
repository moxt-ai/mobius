import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingHistoryPage,
    decodeSessionRecordingTurnItemDetail,
    decodeSessionRecordingTurnItemPage,
    decodeSessionRecordingTurnPage,
    type SessionRecordingTurnPage,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

const worker = createRecordingWorker();
const runtimeId = "runtime-turns";
const sessionId = "turn-session";
let projectId = "";
let testNumber = 0;
let position = 0;
let generation = "generation-1";

beforeEach(() => {
    projectId = `project-turns-${++testNumber}`;
    position = 0;
    generation = "generation-1";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function event(payload: unknown, type: "acp" | "lifecycle-metadata") {
    position += 1;
    return {
        eventId: `event-${position}`,
        payload,
        position: String(position),
        provenance: { kind: "original" },
        recordedAt: new Date(Date.parse("2026-10-15T00:00:00.000Z") + position * 1_000).toISOString(),
        sessionGenerationId: generation,
        sessionId,
        type,
    };
}

const lifecycle = (payload: unknown) => event(payload, "lifecycle-metadata");
const acp = (payload: unknown) => event(payload, "acp");
const requested = (commandId: string, text: string) =>
    lifecycle({ commandId, content: [{ text, type: "text" }], kind: "prompt.requested" });
const started = (commandId: string) =>
    lifecycle({ attemptId: `attempt-${commandId}`, commandId, epoch: "epoch-1", kind: "prompt.started" });
const completed = (commandId: string) => lifecycle({ commandId, kind: "prompt.completed", stopReason: "end_turn" });
const answer = (text: string) =>
    acp({ content: { text, type: "text" }, messageId: "message-1", sessionUpdate: "agent_message_chunk" });
const thought = (text: string) =>
    acp({ content: { text, type: "text" }, messageId: "message-1", sessionUpdate: "agent_thought_chunk" });

async function record(events: readonly unknown[]): Promise<void> {
    const response = await worker.fetch(
        new Request("https://recording.internal/v1/session-events", {
            body: JSON.stringify({ envelope: { events, kind: "session.event.v2" }, projectId, runtimeId }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
        env,
    );
    expect(response.status).toBe(201);
}

async function completedTurn(commandId: string, prompt: string, reply: string): Promise<void> {
    await record([requested(commandId, prompt), started(commandId), answer(reply), completed(commandId)]);
}

function sessionPath(suffix: string): string {
    return `https://recording.internal/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/${suffix}`;
}

async function turnPage(query = ""): Promise<SessionRecordingTurnPage> {
    const response = await worker.fetch(new Request(sessionPath(`turns${query}`)), env);
    expect(response.status).toBe(200);
    return decodeSessionRecordingTurnPage(await response.text());
}

function promptText(page: SessionRecordingTurnPage): readonly string[] {
    return page.turns.map((turn) => {
        const block = turn.prompt?.content[0];
        return block?.type === "text" ? block.text : "";
    });
}

describe("Recording Turn history", () => {
    it("Given streamed answer, reasoning, and tool chunks, When a client reads the newest Turns, Then each Turn lists merged items in order", async () => {
        await record([requested("command-1", "Inspect the repository"), started("command-1")]);
        await record([thought("Looking "), thought("around."), answer("I will "), answer("read it.")]);
        await record([
            acp({ sessionUpdate: "tool_call", status: "in_progress", title: "Read file", toolCallId: "tool-1" }),
            acp({
                rawOutput: { lines: 3 },
                sessionUpdate: "tool_call_update",
                status: "completed",
                toolCallId: "tool-1",
            }),
            answer("Done."),
            acp({ sessionUpdate: "session_info_update", title: "Repository inspection" }),
            completed("command-1"),
        ]);

        const page = await turnPage();
        expect(page.title).toBe("Repository inspection");
        expect(page.activeCommands).toBeNull();
        expect(page.nextCursor).toBeNull();
        expect(page.turns).toHaveLength(1);
        const [turn] = page.turns;
        expect(turn).toMatchObject({
            answerLength: "I will read it.Done.".length,
            attempt: { attemptId: "attempt-command-1", kind: "succeeded", stopReason: "end_turn" },
            commandId: "command-1",
            itemCount: 4,
            itemsCursor: null,
            messageId: "message-1",
        });
        expect(turn?.items).toMatchObject([
            { kind: "thought", sequence: 0, text: "Looking around." },
            { kind: "answer", sequence: 1, text: "I will read it." },
            {
                attemptId: "attempt-command-1",
                detail: { kind: "inline", rawOutput: { lines: 3 } },
                kind: "tool",
                sequence: 2,
                status: "completed",
                title: "Read file",
                toolCallId: "tool-1",
            },
            { kind: "answer", sequence: 3, text: "Done." },
        ]);
    });

    it("Given many Turns, When a client pages older Turns while new Turns arrive, Then every Turn is listed once", async () => {
        for (let index = 1; index <= 5; index += 1) {
            await completedTurn(`command-${index}`, `Prompt ${index}`, `Reply ${index}`);
        }
        const newest = await turnPage("?limit=2");
        expect(promptText(newest)).toEqual(["Prompt 5", "Prompt 4"]);
        expect(newest.nextCursor).toBe("turn:4");

        await completedTurn("command-6", "Prompt 6", "Reply 6");
        const older = await turnPage(`?limit=2&before=${encodeURIComponent(newest.nextCursor ?? "")}`);
        expect(promptText(older)).toEqual(["Prompt 3", "Prompt 2"]);
        const oldest = await turnPage(`?limit=2&before=${encodeURIComponent(older.nextCursor ?? "")}`);
        expect(promptText(oldest)).toEqual(["Prompt 1"]);
        expect(oldest.nextCursor).toBeNull();
    });

    it("Given a Turn history snapshot, When a client continues from its tail cursor, Then live events start right after the snapshot", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        const snapshot = await turnPage();
        await record([requested("command-2", "Prompt 2"), started("command-2")]);

        const live = await worker.fetch(
            new Request(sessionPath(`events?after=${encodeURIComponent(snapshot.tailCursor)}&limit=100`)),
            env,
        );
        expect(live.status).toBe(200);
        const page = decodeSessionRecordingHistoryPage(await live.text());
        expect(page.events.map((candidate) => candidate.eventId)).toEqual(["event-5", "event-6"]);
        expect((await turnPage()).activeCommands).toEqual({
            commandIds: ["command-2"],
            generationId: "generation-1",
        });
    });

    it("Given a pending permission and a restarted local Agent, When a client reads Turns, Then the interrupted attempt is indeterminate and its request is no longer pending", async () => {
        const permission = {
            commandId: "command-1",
            interactionId: "interaction-1",
            kind: "session.permission.requested",
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
            sessionId,
            title: "Run command",
            toolCallId: "tool-1",
            toolKind: "execute",
        };
        await record([
            requested("command-1", "Run tests"),
            started("command-1"),
            lifecycle({ event: permission, kind: "session.permission.requested" }),
        ]);
        const waiting = await turnPage();
        expect(waiting.turns[0]?.attempt).toMatchObject({ interactionIds: ["interaction-1"], kind: "waiting_input" });
        expect(waiting.interactions).toMatchObject([
            { commandId: "command-1", interactionId: "interaction-1", kind: "permission" },
        ]);

        generation = "generation-2";
        await record([requested("command-2", "Try again")]);
        const restarted = await turnPage();
        expect(restarted.interactions).toEqual([]);
        expect(restarted.turns.map((turn) => [turn.commandId, turn.attempt.kind])).toEqual([
            ["command-2", "none"],
            ["command-1", "indeterminate"],
        ]);
        expect(restarted.turns[1]?.attempt).toMatchObject({
            attemptId: "attempt-command-1",
            reason: "session_generation_changed",
        });
    });

    it("Given a Turn with many tool calls and an oversized output, When a client reads it, Then pages bound the listing and full reads return every item", async () => {
        await record([requested("command-1", "Scan everything"), started("command-1")]);
        const tools = Array.from({ length: 250 }, (_, index) =>
            acp({
                sessionUpdate: "tool_call",
                status: "completed",
                title: `Read ${index}`,
                toolCallId: `tool-${index}`,
            }),
        );
        await record(tools);
        await record([
            acp({
                rawOutput: "x".repeat(40_000),
                sessionUpdate: "tool_call",
                status: "completed",
                title: "Large read",
                toolCallId: "tool-large",
            }),
            completed("command-1"),
        ]);

        const [turn] = (await turnPage()).turns;
        expect(turn?.itemCount).toBe(251);
        expect(turn?.items).toHaveLength(200);
        expect(turn?.itemsCursor).toBe("item:199");

        const rest = await worker.fetch(
            new Request(sessionPath(`turns/command-1/items?after=${encodeURIComponent(turn?.itemsCursor ?? "")}`)),
            env,
        );
        expect(rest.status).toBe(200);
        const remaining = decodeSessionRecordingTurnItemPage(await rest.text());
        expect(remaining.items).toHaveLength(51);
        expect(remaining.nextCursor).toBeNull();
        const large = remaining.items.at(-1);
        expect(large).toMatchObject({ detail: { kind: "omitted" }, itemId: "tool:tool-large", kind: "tool" });

        const detail = await worker.fetch(
            new Request(sessionPath(`turns/command-1/items/${encodeURIComponent("tool:tool-large")}`)),
            env,
        );
        expect(detail.status).toBe(200);
        expect(decodeSessionRecordingTurnItemDetail(await detail.text()).item).toMatchObject({
            detail: { kind: "inline", rawOutput: "x".repeat(40_000) },
        });
    });

    it("Given a Recording written before its Turn history existed, When a client reads Turns, Then a retryable error is returned until a backfill step catches up", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        await completedTurn("command-2", "Prompt 2", "Reply 2");
        const projected = await turnPage();
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            for (const table of [
                "recording_projection",
                "recorded_turns",
                "recorded_turn_items",
                "recorded_interactions",
            ]) {
                state.storage.sql.exec(`DELETE FROM ${table}`);
            }
        });

        const building = await worker.fetch(new Request(sessionPath("turns")), env);
        expect(building.status).toBe(503);
        expect(building.headers.get("retry-after")).toBe("1");
        expect(await building.json()).toMatchObject({ error: { code: "projection_building" } });

        // New batches are recorded meanwhile and must not be folded ahead of the older batches.
        await completedTurn("command-3", "Prompt 3", "Reply 3");
        while (await runDurableObjectAlarm(stub)) {
            // Each alarm folds one bounded step and schedules the next until the projection is caught up.
        }

        const rebuilt = await turnPage();
        expect(promptText(rebuilt)).toEqual(["Prompt 3", "Prompt 2", "Prompt 1"]);
        expect(rebuilt.turns.slice(1)).toEqual(projected.turns);
    });

    it("Given an unknown Session or a malformed cursor, When a client reads Turns, Then the read is rejected", async () => {
        expect((await worker.fetch(new Request(sessionPath("turns")), env)).status).toBe(404);
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        expect((await worker.fetch(new Request(sessionPath("turns?before=item:1")), env)).status).toBe(400);
        expect((await worker.fetch(new Request(sessionPath("turns?limit=101")), env)).status).toBe(400);
        expect((await worker.fetch(new Request(sessionPath("turns/command-9/items")), env)).status).toBe(404);
    });
});
