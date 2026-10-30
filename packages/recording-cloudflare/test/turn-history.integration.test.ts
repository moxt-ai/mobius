import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingHistoryPage,
    decodeSessionRecordingTurnItemDetail,
    decodeSessionRecordingTurnItemPage,
    decodeSessionRecordingTurnPage,
    type SessionRecordingTurnItem,
    type SessionRecordingTurnPage,
} from "@moxt-ai/mobius-sdk/protocol";
import { decodeSessionRecordingTurnPage as decodePreviousTurnPage } from "@moxt-ai/mobius-sdk-previous/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillEventsPerStep } from "../src/service/session-turn-history.ts";
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
    // Native alarm delivery must remain under the test's explicit control.
    vi.setSystemTime(new Date("2090-10-15T00:00:00.000Z"));
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
        new Request("https://recording.internal/v1/session-event-batches", {
            body: JSON.stringify({ envelope: { events, kind: "session.event.v2" }, projectId, runtimeId }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
        env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ results: [{ sessionId, kind: "recorded" }] });
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

async function itemDetail(commandId: string, itemId: string): Promise<SessionRecordingTurnItem> {
    const response = await worker.fetch(
        new Request(sessionPath(`turns/${commandId}/items/${encodeURIComponent(itemId)}`)),
        env,
    );
    expect(response.status).toBe(200);
    const item = decodeSessionRecordingTurnItemDetail(await response.text())?.item;
    if (item === undefined) {
        throw new Error("expected a known Turn item");
    }
    return item;
}

function promptText(page: SessionRecordingTurnPage): readonly string[] {
    return page.turns.map((turn) => {
        const block = turn.prompt?.content[0];
        return block?.type === "text" ? block.text : "";
    });
}

async function runDueAlarm(stub: DurableObjectStub): Promise<boolean> {
    const at = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    return at !== null && at <= Date.now() ? await runDurableObjectAlarm(stub) : false;
}

describe("Recording Turn history", () => {
    it("Given context compaction, When a client reads during compaction and after completion, Then the same ordered status survives another read", async () => {
        const compactionId = `native/context ${"x".repeat(130)}`;
        await record([
            requested("command-compact", "Continue the task"),
            started("command-compact"),
            answer("Earlier work"),
            acp({ compactionId, sessionUpdate: "compaction_update", status: "in_progress" }),
        ]);
        expect((await turnPage()).turns[0]).toMatchObject({
            answerLength: 12,
            compactions: [{ compactionId, sequence: 1, status: "in_progress" }],
            items: [{ kind: "answer", sequence: 0, text: "Earlier work" }],
        });

        await record([
            acp({ compactionId, sessionUpdate: "compaction_update", status: "in_progress" }),
            acp({ compactionId, sessionUpdate: "compaction_update", status: "completed" }),
            answer("Continued work"),
            completed("command-compact"),
        ]);
        const page = await turnPage();
        expect(page.turns[0]).toMatchObject({
            attempt: { kind: "succeeded" },
            compactions: [{ compactionId, sequence: 1, status: "completed" }],
            itemCount: 2,
            items: [
                { kind: "answer", sequence: 0, text: "Earlier work" },
                { kind: "answer", sequence: 2, text: "Continued work" },
            ],
        });
        expect(await turnPage()).toEqual(page);

        const wire = await worker.fetch(new Request(sessionPath("turns")), env);
        const previous = decodePreviousTurnPage(await wire.text());
        expect(previous.turns[0]).toMatchObject({
            attempt: { kind: "succeeded" },
            items: [
                { kind: "answer", text: "Earlier work" },
                { kind: "answer", text: "Continued work" },
            ],
        });
        // The released decoder serializes the independently retained old response contract.
        expect(decodeSessionRecordingTurnPage(JSON.stringify(previous))).toMatchObject({
            turns: [{ commandId: "command-compact", items: previous.turns[0]?.items }],
        });
    });

    it("Given failed and interrupted compactions, When the Turn settles or its process restarts, Then history reports a terminal compaction status", async () => {
        await record([
            requested("command-failed", "Continue after compaction fails"),
            started("command-failed"),
            acp({ compactionId: "compact-failed", sessionUpdate: "compaction_update", status: "in_progress" }),
            acp({ compactionId: "compact-failed", sessionUpdate: "compaction_update", status: "failed" }),
            answer("The task can still finish"),
            completed("command-failed"),
            requested("command-interrupted", "Continue interrupted work"),
            started("command-interrupted"),
            acp({ compactionId: "compact-interrupted", sessionUpdate: "compaction_update", status: "in_progress" }),
        ]);
        generation = "generation-2";
        await record([requested("command-next", "Read after restart"), started("command-next"), answer("Recovered")]);
        const page = await turnPage();
        expect(page.turns.find((turn) => turn.commandId === "command-failed")).toMatchObject({
            compactions: [{ compactionId: "compact-failed", status: "failed" }],
        });
        expect(page.turns.find((turn) => turn.commandId === "command-interrupted")).toMatchObject({
            attempt: { kind: "indeterminate" },
            compactions: [{ compactionId: "compact-interrupted", status: "cancelled" }],
        });
    });

    it("Given retained compactions and a completed update replay, When history is rebuilt, Then completed compactions stay complete and answers keep their order", async () => {
        await record([
            requested("command-replay", "Read retained context"),
            started("command-replay"),
            acp({ compactionId: "compact-replay", sessionUpdate: "compaction_update", status: "completed" }),
            acp({ compactionId: "compact-replay", sessionUpdate: "compaction_update", status: "in_progress" }),
            answer("Retained answer"),
            completed("command-replay"),
        ]);
        const projected = await turnPage();
        expect(projected.turns[0]).toMatchObject({
            compactions: [{ compactionId: "compact-replay", sequence: 0, status: "completed" }],
            items: [{ kind: "answer", sequence: 1, text: "Retained answer" }],
        });
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec(
                "UPDATE recording_projection SET state_json = json_remove(state_json, '$.compactionVersion')",
            );
        });
        // Existing Recordings recover compactions from their authoritative raw events.
        expect(await turnPage()).toEqual(projected);
    });

    it("Given a compaction in an attempt that is replaced, When another attempt starts, Then the earlier compaction stops running", async () => {
        await record([
            requested("command-retry", "Continue the task"),
            started("command-retry"),
            acp({ compactionId: "compact-old-attempt", sessionUpdate: "compaction_update", status: "in_progress" }),
            lifecycle({
                attemptId: "attempt-replacement",
                commandId: "command-retry",
                epoch: "epoch-1",
                kind: "prompt.started",
            }),
            answer("Continuing in a fresh attempt"),
        ]);
        expect((await turnPage()).turns[0]).toMatchObject({
            attempt: { attemptId: "attempt-replacement", kind: "running" },
            compactions: [{ compactionId: "compact-old-attempt", status: "cancelled" }],
        });
    });

    it("Given more compactions than fit in a Turn summary, When history is read, Then recent compactions and subsequent answers remain readable", async () => {
        const events = [
            requested("command-bounded", "Continue a long task"),
            started("command-bounded"),
            ...Array.from({ length: 1_001 }, (_, index) =>
                acp({
                    compactionId: `compact-${index.toString()}`,
                    sessionUpdate: "compaction_update",
                    status: "completed",
                }),
            ),
            answer("Still readable"),
            completed("command-bounded"),
        ];
        await record(events.slice(0, 1_000));
        await record(events.slice(1_000));
        const turn = (await turnPage()).turns[0];
        expect(turn?.compactions).toHaveLength(1_000);
        expect(turn?.compactions?.[0]).toMatchObject({ compactionId: "compact-1", sequence: 1 });
        expect(turn?.compactions?.at(-1)).toMatchObject({ compactionId: "compact-1000", sequence: 1_000 });
        expect(turn?.items).toMatchObject([{ kind: "answer", sequence: 1_001, text: "Still readable" }]);
    });

    it("Given duplicate event frames, When Turns are updated and rebuilt, Then each logical event contributes once while raw frames remain intact", async () => {
        const begin = [requested("command-1", "Say hello"), started("command-1")];
        const output = answer("Hello");
        await record([...begin, output, output]);
        await record([output]);
        expect((await turnPage()).turns[0]).toMatchObject({
            answerLength: 5,
            items: [{ kind: "answer", text: "Hello" }],
        });

        const rest = [answer("Hello"), completed("command-1")];
        await record(rest);
        await record([output]);
        const projected = await turnPage();
        expect(projected.turns[0]).toMatchObject({
            answerLength: 10,
            attempt: { kind: "succeeded" },
            items: [{ kind: "answer", text: "HelloHello" }],
        });
        const frames = [...begin, output, output, output, ...rest, output];
        const raw = await worker.fetch(new Request(sessionPath("events")), env);
        expect(await raw.json()).toMatchObject({ events: frames });

        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            // A deployed projection predates duplicate suppression and may already contain repeated text.
            state.storage.sql.exec("UPDATE recording_projection SET state_json = json_remove(state_json, '$.version')");
            state.storage.sql.exec("UPDATE recorded_turn_items SET text = text || 'Hello'");
            state.storage.sql.exec("UPDATE recorded_turns SET turn_json = json_set(turn_json, '$.answerLength', 15)");
        });
        // The read rebuilds through the same bounded backfill step as an existing Recording.
        expect(await turnPage()).toEqual(projected);
        const rebuiltRaw = await worker.fetch(new Request(sessionPath("events")), env);
        expect(await rebuiltRaw.json()).toMatchObject({ events: frames });
    });
    it("Given terminal events without message identities, When Recording persists and reads them, Then their outcomes round-trip unchanged", async () => {
        const events = [
            lifecycle({
                commandId: "completed",
                kind: "prompt.completed",
                stopReason: "end_turn",
            }),
            lifecycle({
                commandId: "failed",
                attemptId: "attempt-2",
                kind: "prompt.failed",
                code: "agent_failed",
                message: "The prompt failed",
            }),
            completed("completed-without-id"),
            lifecycle({
                commandId: "failed-without-id",
                attemptId: "attempt-4",
                kind: "prompt.failed",
                code: "agent_failed",
                message: "The prompt failed",
            }),
        ];
        await record(events);
        const response = await worker.fetch(new Request(sessionPath("events?limit=100")), env);
        expect(response.status).toBe(200);
        const page = decodeSessionRecordingHistoryPage(await response.text());
        expect(page.events).toEqual(events);
    });

    it("Given a prompt request followed by live user chunks, When a client reads recorded Turns, Then the request remains the single prompt", async () => {
        const request = requested("command-1", "Inspect the repository");
        const chunk = () =>
            acp({
                content: { text: "Inspect the repository", type: "text" },
                messageId: request.eventId,
                sessionUpdate: "user_message_chunk",
            });
        await record([request, chunk(), started("command-1"), chunk(), answer("Done"), completed("command-1")]);
        const page = await turnPage();
        expect(promptText(page)).toEqual(["Inspect the repository"]);
        expect(page.turns).toHaveLength(1);
        expect(page.turns[0]?.itemCount).toBe(1);
    });

    // @no-uc: Compatibility; named execution reads return metadata without Runtime access or transcript content.
    it("Given recorded outcomes and waiting work, When execution is queried by command, Then it returns only named execution facts", async () => {
        await completedTurn("old-command", "A private old prompt", "A private old answer");
        await completedTurn("newer-command", "A newer prompt", "A newer answer");
        await record([
            requested("running-command", "Keep working"),
            started("running-command"),
            lifecycle({
                commandId: "queued-command",
                content: [{ type: "text", text: "A private queued prompt" }],
                disposition: "queue",
                targetCommandId: "running-command",
                kind: "prompt.requested",
            }),
        ]);
        const query = new URLSearchParams();
        for (const commandId of ["old-command", "queued-command", "unrecorded-command"]) {
            query.append("commandId", commandId);
        }
        const response = await worker.fetch(new Request(sessionPath(`execution?${query}`)), env);
        expect(response.status).toBe(200);
        const snapshot = await response.json();
        expect(snapshot).toMatchObject({
            version: 1,
            sessionId,
            activeCommands: { commandIds: ["running-command"], generationId: generation },
            commands: [
                { commandId: "old-command", attempt: { kind: "succeeded" } },
                { commandId: "queued-command", attempt: { kind: "none" } },
            ],
        });
        const encoded = JSON.stringify(snapshot);
        expect(encoded).not.toContain("private");
        expect(encoded).not.toContain("unrecorded-command");
    });

    // @no-uc: Technical regression; generation interruption remains an explicit recorded fact.
    it("Given an interrupted recorded attempt, When a later generation is recorded, Then an execution read preserves the explicit unknown outcome", async () => {
        await record([requested("interrupted-command", "Inspect"), started("interrupted-command")]);
        generation = "generation-2";
        await record([requested("current-command", "Continue"), started("current-command")]);
        const response = await worker.fetch(new Request(sessionPath("execution?commandId=interrupted-command")), env);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            activeCommands: { commandIds: ["current-command"], generationId: generation },
            commands: [
                {
                    commandId: "interrupted-command",
                    attempt: { kind: "indeterminate", reason: "session_generation_changed" },
                },
            ],
        });
    });

    it("Given more than a thousand active commands, When execution is queried, Then named outcomes remain readable with a bounded active stack", async () => {
        await completedTurn("finished-command", "Finished prompt", "Finished answer");
        for (let offset = 0; offset < 1_001; offset += 100) {
            const events = Array.from({ length: Math.min(100, 1_001 - offset) }, (_, index) => {
                const commandId = `active-${offset + index}`;
                return [requested(commandId, "Waiting for completion"), started(commandId)];
            }).flat();
            await record(events);
        }

        const response = await worker.fetch(new Request(sessionPath("execution?commandId=finished-command")), env);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            commands: [{ commandId: "finished-command", attempt: { kind: "succeeded" } }],
            activeCommands: { commandIds: Array.from({ length: 1_000 }, (_, index) => `active-${index + 1}`) },
        });
    });

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
        position = 0;
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

    it("Given a Turn with many tool calls and an oversized output, When a client reads it, Then a page starts at its conclusion and reads its work back", async () => {
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
        // A page starts from the end of the Turn, so the work a member reads back is the work that
        // produced the conclusion the page does show.
        expect(turn?.items).toHaveLength(200);
        expect(turn?.items[0]?.itemId).toBe("tool:tool-51");
        expect(turn?.itemsCursor).toBe("before:item:51");
        expect(turn?.items.at(-1)).toMatchObject({
            detail: { kind: "omitted" },
            itemId: "tool:tool-large",
            kind: "tool",
        });

        // The listed run is the Turn's conclusion; `before` reads the work that produced it.
        const earlier = await worker.fetch(
            new Request(sessionPath(`turns/command-1/items?before=${encodeURIComponent(turn?.itemsCursor ?? "")}`)),
            env,
        );
        expect(earlier.status).toBe(200);
        const back = decodeSessionRecordingTurnItemPage(await earlier.text());
        expect(back.items).toHaveLength(51);
        expect(back.items[0]?.itemId).toBe("tool:tool-0");
        expect(back.items.at(-1)?.itemId).toBe("tool:tool-50");
        expect(back.nextCursor).toBeNull();

        // The forward read a caller uses to follow work still being produced continues the same
        // boundary in the other direction, so it names its own cursor.
        const later = await worker.fetch(new Request(sessionPath("turns/command-1/items?after=after:item:51")), env);
        expect(later.status).toBe(200);
        const forward = decodeSessionRecordingTurnItemPage(await later.text());
        expect(forward.items).toHaveLength(199);
        expect(forward.nextCursor).toBeNull();
        // Reading back and reading forward meet on the same boundary and never repeat an item.
        expect(forward.items.map((item) => item.itemId)).not.toContain(back.items.at(-1)?.itemId);

        const detail = await worker.fetch(
            new Request(sessionPath(`turns/command-1/items/${encodeURIComponent("tool:tool-large")}`)),
            env,
        );
        expect(detail.status).toBe(200);
        expect(decodeSessionRecordingTurnItemDetail(await detail.text())?.item).toMatchObject({
            detail: { kind: "inline", rawOutput: "x".repeat(40_000) },
        });
    });

    it("Given a Turn a client is reading back to its start, When it follows the cursor, Then no item is repeated and every one arrives", async () => {
        await record([requested("command-1", "Do a lot of work"), started("command-1")]);
        await record(
            Array.from({ length: 30 }, (_, index) =>
                acp({
                    sessionUpdate: "tool_call",
                    status: "completed",
                    title: `Read ${index}`,
                    toolCallId: `tool-${index}`,
                }),
            ),
        );
        await record([acp({ content: { text: "All done", type: "text" }, sessionUpdate: "agent_message_chunk" })]);

        const [turn] = (await turnPage()).turns;
        expect(turn?.itemCount).toBe(31);
        const seen = new Set(turn?.items.map((item) => item.itemId));
        expect(seen.size).toBe(turn?.items.length);

        // Following the cursor to the start of the Turn walks its work in order and never repeats.
        let cursor = turn?.itemsCursor ?? null;
        const walked = [...(turn?.items ?? [])];
        while (cursor !== null) {
            const response = await worker.fetch(
                new Request(sessionPath(`turns/command-1/items?before=${encodeURIComponent(cursor)}`)),
                env,
            );
            expect(response.status).toBe(200);
            const page = decodeSessionRecordingTurnItemPage(await response.text());
            expect(page.items.length).toBeGreaterThan(0);
            for (const item of page.items) {
                expect(seen.has(item.itemId)).toBe(false);
                seen.add(item.itemId);
            }
            walked.unshift(...page.items);
            cursor = page.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(walked).toHaveLength(31);
        // Walking back lands on the work that produced the conclusion the first page showed.
        expect(walked[0]?.itemId).toBe("tool:tool-0");
        expect(walked.at(-1)?.itemId).toContain("answer");
    });

    it("Given a Turn still being produced, When a client reads its page, Then the work it is still producing is what the page leads with", async () => {
        await record([requested("command-1", "Keep going"), started("command-1")]);
        await record(
            Array.from({ length: 220 }, (_, index) =>
                acp({
                    sessionUpdate: "tool_call",
                    status: "completed",
                    title: `Read ${index}`,
                    toolCallId: `tool-${index}`,
                }),
            ),
        );
        await record([acp({ content: { text: "Still working", type: "text" }, sessionUpdate: "agent_message_chunk" })]);

        const [turn] = (await turnPage()).turns;
        expect(turn?.itemCount).toBe(221);
        // The answer is still growing at the end of the Turn, so it is what a member reads first.
        expect(turn?.items.at(-1)).toMatchObject({ kind: "answer", text: "Still working" });
        expect(turn?.itemsCursor).toBe("before:item:21");
    });

    it("Given a Turn whose items a client is reading back, When the read asks for both directions at once, Then it is rejected", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        const both = await worker.fetch(
            new Request(sessionPath("turns/command-1/items?after=item:0&before=item:2")),
            env,
        );
        expect(both.status).toBe(400);
    });

    it("Given a Turn folded before the steering anchor was recorded, When a client reads Turns, Then it is read as a prompt no other command was running for", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        // A Turn folded before the anchor existed carries no such key at all. Reading it must not
        // fail the page it is on: an unplaced prompt is what that Turn is.
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec(`UPDATE recorded_turns SET turn_json = json_remove(turn_json, '$.preceding')`);
        });

        const page = await turnPage();
        expect(page.turns).toHaveLength(1);
        expect(page.turns[0]?.preceding).toBeNull();
    });

    it("Given a projection folded before the current Turn history version, When a client reads Turns, Then the read rebuilds it from the Recording and answers", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        await completedTurn("command-2", "Prompt 2", "Reply 2");
        const projected = await turnPage();
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            // A deployment that folds Turns differently treats every projection written before it as outdated.
            state.storage.sql.exec(
                "UPDATE recording_projection SET state_json = json_remove(state_json, '$.activityVersion')",
            );
        });

        expect(await turnPage()).toEqual(projected);
    });

    it("Given a Recording longer than one backfill step and written before its Turn history existed, When a client reads Turns, Then a retryable error is returned until backfill catches up", async () => {
        await record([requested("command-1", "Prompt 1"), started("command-1")]);
        // A step folds whole batches until it reaches its budget, so the Recording spans more batches than that.
        for (let recorded = 0; recorded <= backfillEventsPerStep; recorded += 1_000) {
            await record(Array.from({ length: 1_000 }, () => answer("Reply 1 ")));
        }
        await record([completed("command-1")]);
        await completedTurn("command-2", "Prompt 2", "Reply 2");
        const projected = await turnPage();
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            for (const table of [
                "recording_projection",
                "projected_session_events",
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
        while (await runDueAlarm(stub)) {
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
        const full = decodeSessionRecordingTurnItemDetail(await detail.text())?.item;
        expect(full).toBeDefined();
        if (full === undefined) {
            throw new Error("expected a known Turn item");
        }
        expect(full).toMatchObject({ kind: "answer", omittedCharacters: 0 });
        expect(full.kind === "answer" ? full.text : "").toBe(chunk.repeat(10));
    });

    it("Given an answer a stored Turn item can hold whole, When a client reads it, Then none of it is omitted", async () => {
        await record([requested("command-1", "Write a lot"), started("command-1")]);
        const chunk = "abcdefghij".repeat(30_000);
        for (let index = 0; index < 4; index += 1) {
            await record([answer(chunk)]);
        }
        await record([completed("command-1")]);

        const [item] = (await turnPage()).turns[0]?.items ?? [];
        const full = await itemDetail("command-1", item?.itemId ?? "");
        expect(full).toMatchObject({ kind: "answer", omittedCharacters: 0 });
        expect(full.kind === "answer" ? full.text : "").toBe(chunk.repeat(4));
    });

    it("Given an answer longer than a stored Turn item holds, When a client reads it, Then the stored text keeps its order and the rest is counted as omitted", async () => {
        await record([requested("command-1", "Write a lot"), started("command-1")]);
        const chunk = "abcdefghij".repeat(60_000);
        for (let index = 0; index < 4; index += 1) {
            await record([answer(chunk)]);
        }
        // Text arriving once the stored part is full is never placed after it out of order.
        await record([answer("tail"), completed("command-1")]);

        const [turn] = (await turnPage()).turns;
        expect(turn?.answerLength).toBe(2_400_004);
        const [item] = turn?.items ?? [];
        expect(item).toMatchObject({ kind: "answer", omittedCharacters: 2_300_004 });
        const full = await itemDetail("command-1", item?.itemId ?? "");
        expect(full).toMatchObject({ kind: "answer", omittedCharacters: 600_004 });
        expect(full.kind === "answer" ? full.text : "").toBe(chunk.repeat(3));
    });

    it("Given reasoning longer than a stored Turn item holds, When Turn history is rebuilt from the Recording, Then whole characters are stored and the rest is counted as omitted", async () => {
        await record([requested("command-1", "Think"), started("command-1")]);
        // Each of these characters takes three bytes, so the stored part has to end on a whole character.
        await record([thought("€".repeat(350_000))]);
        await record([thought("€".repeat(350_000)), completed("command-1")]);
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            for (const table of [
                "recording_projection",
                "projected_session_events",
                "recorded_turns",
                "recorded_turn_items",
                "recorded_interactions",
            ]) {
                state.storage.sql.exec(`DELETE FROM ${table}`);
            }
        });
        // The read that finds the projection behind folds both chunks into the item it creates.
        const [item] = (await turnPage()).turns[0]?.items ?? [];
        const full = await itemDetail("command-1", item?.itemId ?? "");
        expect(full).toMatchObject({ kind: "thought", omittedCharacters: 66_667 });
        expect(full.kind === "thought" ? full.text : "").toBe("€".repeat(633_333));
    });

    it("Given a tool call whose merged detail is larger than a stored Turn item holds, When later patches only change its status, Then the tool keeps its labels and still reports its detail as omitted", async () => {
        await record([
            requested("command-1", "Rewrite the notes"),
            started("command-1"),
            acp({
                rawInput: { content: "x".repeat(1_000_000), path: "notes.txt" },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Write notes.txt",
                toolCallId: "tool-1",
            }),
        ]);
        await record([
            acp({
                rawOutput: "y".repeat(1_000_000),
                sessionUpdate: "tool_call_update",
                status: "in_progress",
                toolCallId: "tool-1",
            }),
        ]);
        await record([
            acp({ sessionUpdate: "tool_call_update", status: "completed", toolCallId: "tool-1" }),
            completed("command-1"),
        ]);

        expect((await turnPage()).turns[0]?.attempt.kind).toBe("succeeded");
        expect(await itemDetail("command-1", "tool:tool-1")).toMatchObject({
            detail: { kind: "omitted" },
            kind: "tool",
            status: "completed",
            title: "Write notes.txt",
        });
    });

    it("Given an answer chunk this Recording cannot read, When later text is recorded, Then the answer reports the characters it misses instead of reading as complete", async () => {
        await record([requested("command-1", "Answer"), started("command-1"), answer("A")]);
        // The tolerant ingest schema accepts a chunk the live schema bounds to a million characters.
        await record([
            acp({
                content: { text: "B".repeat(1_000_001), type: "text" },
                messageId: "message-1",
                sessionUpdate: "agent_message_chunk",
            }),
        ]);
        await record([answer("C"), completed("command-1")]);

        const [turn] = (await turnPage()).turns;
        expect(turn).toMatchObject({ answerLength: 1_000_003, attempt: { kind: "succeeded" } });
        expect(turn?.items).toMatchObject([{ kind: "answer", omittedCharacters: 1_000_002, text: "A" }]);
        expect(await itemDetail("command-1", turn?.items[0]?.itemId ?? "")).toMatchObject({
            kind: "answer",
            omittedCharacters: 1_000_002,
            text: "A",
        });
    });

    it("Given an Agent update this Recording cannot read, When later work is recorded, Then Turn history stays readable and keeps the work around it", async () => {
        await record([requested("command-1", "Say hello"), started("command-1"), answer("Hel")]);
        // A newer Runtime may forward an update kind this deployment has no schema for yet.
        await record([acp({ sessionUpdate: "future_update", value: 1 }), answer("lo")]);
        await record([completed("command-1")]);
        await completedTurn("command-2", "Again", "Hi");

        const page = await turnPage();
        expect(page.turns.map((turn) => turn.commandId)).toEqual(["command-2", "command-1"]);
        expect(page.turns[1]).toMatchObject({
            attempt: { kind: "succeeded" },
            items: [{ kind: "answer", text: "Hello" }],
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
        while (await runDueAlarm(stub)) {
            // Each due attempt fails on the undecodable state and records the failure.
        }
        const failed = await worker.fetch(new Request(sessionPath("turns")), env);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({ error: { code: "projection_failed" } });
    });

    it("Given an undecodable projection state, When a client reads Turns before backfill runs, Then the read reports the failure its own step records", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec("UPDATE recording_projection SET state_json = '{}'");
        });
        await completedTurn("command-2", "Prompt 2", "Reply 2");

        const failed = await worker.fetch(new Request(sessionPath("turns")), env);
        expect(failed.status).toBe(503);
        expect(failed.headers.get("retry-after")).toBe("1");
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
        expect(
            (await worker.fetch(new Request(sessionPath("turns/command-9/items?before=before:item:2")), env)).status,
        ).toBe(404);
    });

    it("Given a Turn item read that names no direction, both, or the wrong one, When a client reads it, Then the read is rejected", async () => {
        await completedTurn("command-1", "Prompt 1", "Reply 1");
        // A read continues one run, so it names one direction: a page's cursor fed to the other one
        // would overlap the run it came from and list work twice.
        expect((await worker.fetch(new Request(sessionPath("turns/command-1/items")), env)).status).toBe(400);
        expect(
            (
                await worker.fetch(
                    new Request(sessionPath("turns/command-1/items?after=after:item:1&before=before:item:2")),
                    env,
                )
            ).status,
        ).toBe(400);
        expect(
            (await worker.fetch(new Request(sessionPath("turns/command-1/items?after=before:item:2")), env)).status,
        ).toBe(400);
        expect(
            (await worker.fetch(new Request(sessionPath("turns/command-1/items?before=after:item:1")), env)).status,
        ).toBe(400);
    });
});
