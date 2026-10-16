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
const permissionRequest = (commandId: string, interactionId: string) =>
    lifecycle({
        event: {
            commandId,
            interactionId,
            kind: "session.permission.requested",
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
            sessionId,
            title: `Approve ${interactionId}`,
            toolCallId: `tool-${interactionId}`,
            toolKind: "execute",
        },
        kind: "session.permission.requested",
    });
const permissionResolved = (interactionId: string) =>
    lifecycle({
        event: {
            interactionId,
            kind: "session.permission.resolved",
            optionId: "allow",
            outcome: "selected",
            sessionId,
        },
        kind: "session.permission.resolved",
    });

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

    it("Given a Turn waiting on two requests, When they resolve one at a time and the Turn ends, Then it keeps waiting until both are answered and no request outlives it", async () => {
        await record([
            requested("command-1", "Deploy"),
            started("command-1"),
            permissionRequest("command-1", "interaction-1"),
            permissionRequest("command-1", "interaction-2"),
        ]);
        const both = await turnPage();
        expect(both.turns[0]?.attempt).toMatchObject({
            interactionIds: ["interaction-1", "interaction-2"],
            kind: "waiting_input",
        });
        expect(both.interactions.map((interaction) => interaction.interactionId)).toEqual([
            "interaction-1",
            "interaction-2",
        ]);

        await record([permissionResolved("interaction-1")]);
        const one = await turnPage();
        expect(one.turns[0]?.attempt).toMatchObject({ interactionIds: ["interaction-2"], kind: "waiting_input" });
        expect(one.interactions.map((interaction) => interaction.interactionId)).toEqual(["interaction-2"]);

        await record([permissionResolved("interaction-2"), permissionRequest("command-1", "interaction-3")]);
        expect((await turnPage()).turns[0]?.attempt).toMatchObject({
            interactionIds: ["interaction-3"],
            kind: "waiting_input",
        });
        await record([completed("command-1")]);
        const ended = await turnPage();
        expect(ended.turns[0]?.attempt.kind).toBe("succeeded");
        expect(ended.interactions).toEqual([]);
    });

    it("Given an attempt interrupted by a restart, When its request resolves afterwards, Then the attempt stays indeterminate", async () => {
        await record([
            requested("command-1", "Run tests"),
            started("command-1"),
            permissionRequest("command-1", "interaction-1"),
        ]);
        generation = "generation-2";
        await record([requested("command-2", "Try again")]);
        const interrupted = (await turnPage()).turns[1]?.attempt;
        expect(interrupted?.kind).toBe("indeterminate");

        await record([permissionResolved("interaction-1"), permissionRequest("command-1", "interaction-2")]);
        const page = await turnPage();
        expect(page.turns[1]?.attempt).toEqual(interrupted);
        expect(page.interactions).toEqual([]);
    });

    it("Given reasoning from interleaved messages, When a client reads the Turn, Then each run of reasoning keeps its recorded order", async () => {
        const reasoning = (messageId: string, text: string) =>
            acp({ content: { text, type: "text" }, messageId, sessionUpdate: "agent_thought_chunk" });
        await record([
            requested("command-1", "Think"),
            started("command-1"),
            reasoning("message-1", "First "),
            reasoning("message-1", "idea."),
            reasoning("message-2", "Second idea."),
            reasoning("message-1", "Back to the first."),
            completed("command-1"),
        ]);
        expect((await turnPage()).turns[0]?.items).toMatchObject([
            { kind: "thought", sequence: 0, text: "First idea." },
            { kind: "thought", sequence: 1, text: "Second idea." },
            { kind: "thought", sequence: 2, text: "Back to the first." },
        ]);
    });

    it("Given a long answer streamed over many batches, When a client reads it, Then pages list a bounded prefix and the item read returns all of it", async () => {
        await record([requested("command-1", "Write a lot"), started("command-1")]);
        const chunk = "abcdefghij".repeat(1_500);
        for (let index = 0; index < 10; index += 1) {
            await record([answer(chunk)]);
        }
        await record([completed("command-1")]);

        const [turn] = (await turnPage()).turns;
        expect(turn?.answerLength).toBe(150_000);
        const [item] = turn?.items ?? [];
        expect(item).toMatchObject({ kind: "answer", omittedCharacters: 50_000 });
        expect(item?.kind === "answer" ? item.text : "").toBe(chunk.repeat(10).slice(0, 100_000));

        const detail = await worker.fetch(
            new Request(sessionPath(`turns/command-1/items/${encodeURIComponent(item?.itemId ?? "")}`)),
            env,
        );
        expect(detail.status).toBe(200);
        const full = decodeSessionRecordingTurnItemDetail(await detail.text()).item;
        expect(full).toMatchObject({ kind: "answer", omittedCharacters: 0 });
        expect(full.kind === "answer" ? full.text : "").toBe(chunk.repeat(10));
    });

    it("Given a stored Turn that can no longer be folded, When the Session keeps recording, Then events are still recorded and reads report the failure until backfill succeeds", async () => {
        await record([requested("command-1", "Prompt 1"), started("command-1")]);
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        const original = await runInDurableObject(stub, (_instance, state) => {
            const row = state.storage.sql
                .exec("SELECT turn_json FROM recorded_turns WHERE command_id = 'command-1'")
                .toArray()[0];
            state.storage.sql.exec("UPDATE recorded_turns SET turn_json = '{}' WHERE command_id = 'command-1'");
            return String(row?.["turn_json"]);
        });

        await record([answer("Still recorded."), completed("command-1")]);
        const live = await worker.fetch(new Request(sessionPath("events?after=0&limit=100")), env);
        expect(
            decodeSessionRecordingHistoryPage(await live.text()).events.map((candidate) => candidate.eventId),
        ).toEqual(["event-1", "event-2", "event-3", "event-4"]);

        while (await runDurableObjectAlarm(stub)) {
            // Run every backfill attempt that is due; each one fails on the unreadable Turn.
        }
        const failed = await worker.fetch(new Request(sessionPath("turns")), env);
        expect(failed.status).toBe(503);
        expect(Number(failed.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(await failed.json()).toMatchObject({ error: { code: "projection_failed" } });

        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec("UPDATE recorded_turns SET turn_json = ? WHERE command_id = 'command-1'", original);
        });
        await runDurableObjectAlarm(stub);
        const recovered = await turnPage();
        expect(recovered.turns[0]).toMatchObject({
            attempt: { kind: "succeeded" },
            items: [{ kind: "answer", text: "Still recorded." }],
        });
    });

    it("Given a request waiting when a new attempt of its Turn starts, When a client reads Turns, Then the request is no longer pending", async () => {
        await record([
            requested("command-1", "Deploy"),
            started("command-1"),
            permissionRequest("command-1", "interaction-1"),
            lifecycle({ attemptId: "attempt-retry", commandId: "command-1", epoch: "epoch-1", kind: "prompt.started" }),
        ]);
        const page = await turnPage();
        expect(page.turns[0]?.attempt).toMatchObject({ attemptId: "attempt-retry", kind: "running" });
        expect(page.interactions).toEqual([]);
    });

    it("Given an answered request, When the same request event is recorded again, Then it stays answered", async () => {
        await record([
            requested("command-1", "Deploy"),
            started("command-1"),
            permissionRequest("command-1", "interaction-1"),
            permissionResolved("interaction-1"),
            permissionRequest("command-1", "interaction-1"),
        ]);
        const page = await turnPage();
        expect(page.turns[0]?.attempt.kind).toBe("running");
        expect(page.interactions).toEqual([]);
    });

    it("Given answer text from two Agent messages in a row, When a client reads the Turn, Then each message is its own answer item", async () => {
        const reply = (messageId: string, text: string) =>
            acp({ content: { text, type: "text" }, messageId, sessionUpdate: "agent_message_chunk" });
        await record([
            requested("command-1", "Greet"),
            started("command-1"),
            reply("message-1", "Hel"),
            reply("message-1", "lo."),
            reply("message-2", "World."),
            completed("command-1"),
        ]);
        expect((await turnPage()).turns[0]?.items).toMatchObject([
            { kind: "answer", sequence: 0, text: "Hello." },
            { kind: "answer", sequence: 1, text: "World." },
        ]);
    });

    it("Given an undecodable projection state, When backfill runs, Then reads report the failure instead of building forever", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec("UPDATE recording_projection SET state_json = '{}'");
        });
        await completedTurn("command-2", "Prompt 2", "Reply 2");
        while (await runDurableObjectAlarm(stub)) {
            // Each due attempt fails on the undecodable state and records the failure.
        }
        const failed = await worker.fetch(new Request(sessionPath("turns")), env);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({ error: { code: "projection_failed" } });
    });

    it("Given an attempt that failed after answering, When a retry of the same command answers, Then each attempt keeps its own answer item", async () => {
        await record([
            requested("command-1", "Summarize"),
            started("command-1"),
            answer("First try."),
            lifecycle({
                attemptId: "attempt-command-1",
                code: "agent_crashed",
                commandId: "command-1",
                kind: "prompt.failed",
                message: "The Agent stopped",
            }),
            lifecycle({ attemptId: "attempt-retry", commandId: "command-1", epoch: "epoch-1", kind: "prompt.started" }),
            answer("Second try."),
            completed("command-1"),
        ]);
        expect((await turnPage()).turns[0]?.items).toMatchObject([
            { kind: "answer", sequence: 0, text: "First try." },
            { kind: "answer", sequence: 1, text: "Second try." },
        ]);
    });

    it("Given a Turn that fills most of a page, When a client reads Turns, Then an older Turn that does not fit moves to the next page", async () => {
        await completedTurn("command-1", "x".repeat(900_000), "Reply 1");
        await record([
            lifecycle({
                commandId: "command-2",
                content: [
                    { text: "y".repeat(800_000), type: "text" },
                    { text: "z".repeat(800_000), type: "text" },
                ],
                kind: "prompt.requested",
            }),
        ]);
        const newest = await turnPage();
        expect(newest.turns.map((turn) => turn.commandId)).toEqual(["command-2"]);
        expect(newest.nextCursor).toBe("turn:2");
        const older = await turnPage(`?before=${encodeURIComponent(newest.nextCursor ?? "")}`);
        expect(older.turns.map((turn) => turn.commandId)).toEqual(["command-1"]);
    });

    it("Given a batch from a replaced generation that arrives late, When a client reads Turns, Then the current generation keeps running", async () => {
        await record([requested("command-1", "Old run"), started("command-1")]);
        const lateBatch = [answer("Late output from the old process.")];
        generation = "generation-2";
        await record([requested("command-2", "New run"), started("command-2")]);
        generation = "generation-1";
        await record(lateBatch.map((late) => ({ ...late, eventId: `${late.eventId}-late` })));
        generation = "generation-2";
        await record([answer("Current output."), completed("command-2")]);

        const page = await turnPage();
        expect(page.turns.map((turn) => [turn.commandId, turn.attempt.kind])).toEqual([
            ["command-2", "succeeded"],
            ["command-1", "indeterminate"],
        ]);
        expect(page.turns[0]?.items).toMatchObject([{ kind: "answer", text: "Current output." }]);
        expect(page.turns[1]?.items).toEqual([]);
    });

    it("Given more requests than an attempt lists, When the listed ones are answered, Then the attempt keeps waiting on the rest", async () => {
        const requests = Array.from({ length: 101 }, (_, index) =>
            permissionRequest("command-1", `interaction-${String(index).padStart(3, "0")}`),
        );
        await record([requested("command-1", "Approve everything"), started("command-1"), ...requests]);
        const waiting = await turnPage();
        expect(waiting.turns[0]?.attempt.kind).toBe("waiting_input");
        await record(
            Array.from({ length: 100 }, (_, index) =>
                permissionResolved(`interaction-${String(index + 1).padStart(3, "0")}`),
            ),
        );
        const page = await turnPage();
        expect(page.turns[0]?.attempt).toMatchObject({ interactionIds: ["interaction-000"], kind: "waiting_input" });
        expect(page.interactions.map((interaction) => interaction.interactionId)).toEqual(["interaction-000"]);
    });

    it("Given a tool call started by an outer command, When its update arrives while a nested command runs, Then the update lands on the original tool item", async () => {
        await record([
            requested("command-1", "Outer"),
            started("command-1"),
            acp({ sessionUpdate: "tool_call", status: "in_progress", title: "Build", toolCallId: "tool-1" }),
            requested("command-2", "Steer"),
            started("command-2"),
            acp({ sessionUpdate: "tool_call_update", status: "completed", toolCallId: "tool-1" }),
        ]);
        const page = await turnPage();
        expect(page.turns[0]).toMatchObject({ commandId: "command-2", itemCount: 0, items: [] });
        expect(page.turns[1]?.items).toMatchObject([
            { kind: "tool", status: "completed", title: "Build", toolCallId: "tool-1" },
        ]);
    });

    it("Given a steer requested between two tool calls, When a client reads Turns, Then the steer records the running command and how much work it had done", async () => {
        const tool = (toolCallId: string) =>
            acp({ sessionUpdate: "tool_call", status: "completed", title: toolCallId, toolCallId });
        await record([
            requested("command-1", "Refactor"),
            started("command-1"),
            tool("tool-1"),
            tool("tool-2"),
            lifecycle({
                commandId: "command-2",
                content: [{ text: "Use the new API", type: "text" }],
                disposition: "steer",
                kind: "prompt.requested",
                targetCommandId: "command-1",
            }),
            tool("tool-3"),
            completed("command-1"),
        ]);
        const page = await turnPage();
        expect(page.turns.map((turn) => [turn.commandId, turn.preceding])).toEqual([
            ["command-2", { commandId: "command-1", itemCount: 2 }],
            ["command-1", null],
        ]);
    });

    it("Given an unknown Session or a malformed cursor, When a client reads Turns, Then the read is rejected", async () => {
        expect((await worker.fetch(new Request(sessionPath("turns")), env)).status).toBe(404);
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        expect((await worker.fetch(new Request(sessionPath("turns?before=item:1")), env)).status).toBe(400);
        expect((await worker.fetch(new Request(sessionPath("turns?limit=101")), env)).status).toBe(400);
        expect((await worker.fetch(new Request(sessionPath("turns/command-9/items")), env)).status).toBe(404);
    });
});
