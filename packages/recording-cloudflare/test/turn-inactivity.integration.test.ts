import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    decodeSessionRecordingExecution,
    decodeSessionRecordingTurnPage,
    type SessionRecordingTurnPage,
} from "@moxt-ai/mobius-sdk/protocol";
import {
    decodeSessionRecordingExecution as decodePreviousExecution,
    decodeSessionRecordingTurnPage as decodePreviousTurnPage,
    encodeSessionRecordingTurnPage as encodePreviousTurnPage,
} from "@moxt-ai/mobius-sdk-previous/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingWorker } from "../src/worker.ts";

// Failure boundaries: early expiry; an unwatched execution never expiring; another command or
// metadata renewing it; duplicate replay renewing it; waiting requests expiring; partial answers
// renewing waiting work; resumed progress staying unknown; late terminal facts being overwritten;
// a new generation reviving old work; old decoders rejecting the new observation; rebuilding old
// projections losing activity; runtime clock skew extending the server's deadline; elicitation
// being treated differently from permission; an alarm leaving later due commands unassessed;
// non-text Agent output being ignored as progress.
const worker = createRecordingWorker();
const runtimeId = "inactivity-runtime";
const sessionId = "inactivity-session";
const hour = 60 * 60 * 1_000;
// Keep native workerd alarms ahead of wall time; fake Date and explicit alarm delivery own all time.
const start = Date.parse("2090-10-30T00:00:00.000Z");
let projectId = "";
let number = 0;
let position = 0;
let generation = "generation-1";

beforeEach(() => {
    projectId = `inactivity-project-${++number}`;
    position = 0;
    generation = "generation-1";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
});
afterEach(() => vi.useRealTimers());

function event(payload: unknown, type: "acp" | "lifecycle-metadata" = "lifecycle-metadata") {
    position += 1;
    return {
        eventId: `event-${position}`,
        payload,
        position: String(position),
        recordedAt: new Date().toISOString(),
        sessionGenerationId: generation,
        sessionId,
        type,
    };
}

const requested = (commandId: string) =>
    event({ commandId, content: [{ type: "text", text: "Keep working" }], kind: "prompt.requested" });
const started = (commandId: string) =>
    event({ commandId, attemptId: `attempt-${commandId}`, epoch: "epoch", kind: "prompt.started" });
const answer = (text: string) =>
    event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, "acp");
const completed = (commandId: string) => event({ commandId, kind: "prompt.completed", stopReason: "end_turn" });
const permission = (commandId: string, interactionId: string) =>
    event({
        kind: "session.permission.requested",
        event: {
            commandId,
            interactionId,
            kind: "session.permission.requested",
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
            sessionId,
            title: "Approve work",
            toolCallId: `tool-${interactionId}`,
            toolKind: "execute",
        },
    });
const resolved = (interactionId: string) =>
    event({
        kind: "session.permission.resolved",
        event: {
            interactionId,
            kind: "session.permission.resolved",
            outcome: "selected",
            optionId: "allow",
            sessionId,
        },
    });

function path(suffix: string): string {
    return `https://recording.internal/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/${suffix}`;
}

async function record(events: readonly unknown[]): Promise<void> {
    const response = await worker.fetch(
        new Request("https://recording.internal/v1/session-event-batches", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, runtimeId, envelope: { kind: "session.event.v2", events } }),
        }),
        env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ results: [{ sessionId, kind: "recorded" }] });
}

async function read(): Promise<SessionRecordingTurnPage> {
    const response = await worker.fetch(new Request(path("turns")), env);
    expect(response.status).toBe(200);
    return decodeSessionRecordingTurnPage(await response.text());
}

async function execution(...commandIds: string[]) {
    const query = new URLSearchParams(commandIds.map((id) => ["commandId", id]));
    const response = await worker.fetch(new Request(path(`execution?${query}`)), env);
    expect(response.status).toBe(200);
    return decodeSessionRecordingExecution(await response.text());
}

const stub = () => env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));

describe("Recording execution inactivity", () => {
    // Lossy display bounds must not lose progress or make identical detail patches renew activity.
    it.each(["content", "rawInput", "rawOutput"])(
        "Given omitted tool detail, When %s changes and repeats, Then changes renew and recover execution while repeats do not",
        async (field) => {
            const patch = (rawOutput: string) =>
                event(
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "large",
                        [field]:
                            field === "content"
                                ? [{ type: "content", content: { type: "text", text: rawOutput } }]
                                : rawOutput,
                    },
                    "acp",
                );
            await record([
                requested("large"),
                started("large"),
                event(
                    {
                        sessionUpdate: "tool_call",
                        toolCallId: "large",
                        title: "Large tool",
                        status: "in_progress",
                        rawInput: { content: "x".repeat(1_000_000), path: "notes.txt" },
                    },
                    "acp",
                ),
            ]);
            await record([
                event(
                    { sessionUpdate: "tool_call_update", toolCallId: "large", rawOutput: "y".repeat(1_000_000) },
                    "acp",
                ),
            ]);
            expect((await read()).turns[0]?.items[0]).toMatchObject({ detail: { kind: "omitted" } });
            vi.setSystemTime(start + hour - 1);
            await record([patch("changed")]);
            vi.setSystemTime(start + hour + 1);
            await runDurableObjectAlarm(stub());
            expect((await execution("large")).commands[0]?.attempt.kind).toBe("running");
            expect((await read()).turns[0]?.items[0]).toMatchObject({ detail: { kind: "omitted" } });
            vi.setSystemTime(start + 2 * hour - 2);
            await record([patch("changed")]);
            vi.setSystemTime(start + 2 * hour + 1);
            await runDurableObjectAlarm(stub());
            expect((await execution("large")).commands[0]?.attempt.kind).toBe("indeterminate");
            await record([patch("resumed")]);
            expect((await execution("large")).commands[0]?.attempt.kind).toBe("running");
        },
    );
    it("Given unchanged tool status and empty chunks, When they are repeated near the deadline, Then they do not count as execution progress", async () => {
        const tool = {
            sessionUpdate: "tool_call",
            toolCallId: "tool",
            status: "in_progress",
            title: "Work",
            rawInput: { first: 1, second: { a: 1, b: 2 } },
        };
        await record([requested("tool"), started("tool"), event(tool, "acp")]);
        vi.setSystemTime(start + hour - 1);
        await record([
            event(
                {
                    ...tool,
                    rawInput: { second: { b: 2, a: 1 }, first: 1 },
                    sessionUpdate: "tool_call_update",
                },
                "acp",
            ),
            answer(""),
        ]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("tool")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given queued and completed commands, When they remain quiet, Then inactivity does not invent an execution or replace a terminal outcome", async () => {
        await record([requested("queued"), requested("done"), started("done"), completed("done")]);
        vi.setSystemTime(start + 3 * hour);
        await runDurableObjectAlarm(stub());
        expect((await execution("queued", "done")).commands.map((command) => command.attempt.kind)).toEqual([
            "none",
            "succeeded",
        ]);
    });

    it("Given a running command, When one hour passes without progress or a reader, Then an alarm makes its execution and history indeterminate", async () => {
        await record([requested("quiet"), started("quiet"), answer("Started")]);
        vi.setSystemTime(start + hour);
        expect((await execution("quiet")).commands[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + hour + 1);
        expect(await runDurableObjectAlarm(stub())).toBe(true);
        const state = await execution("quiet");
        expect(state.activeCommands).toBeNull();
        expect(state.commands[0]?.attempt).toEqual({
            attemptId: "attempt-quiet",
            startedAt: new Date(start).toISOString(),
            detectedAt: new Date(start + hour + 1).toISOString(),
            kind: "indeterminate",
            reason: "execution_inactive",
        });
        expect((await read()).turns[0]?.attempt).toEqual(state.commands[0]?.attempt);
        expect((await read()).turns[0]?.items).toMatchObject([{ text: "Started" }]);
        vi.setSystemTime(start + 3 * hour);
        expect((await execution("quiet")).commands[0]?.attempt).toEqual(state.commands[0]?.attempt);
    });

    it("Given meaningful progress, When the original deadline passes, Then only the renewed deadline can expire the command", async () => {
        await record([requested("progress"), started("progress")]);
        vi.setSystemTime(start + hour - 1);
        await record([answer("Still working")]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("progress")).commands[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + 2 * hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("progress")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given non-text Agent output, When it arrives near the deadline, Then it renews execution progress", async () => {
        await record([requested("image"), started("image")]);
        vi.setSystemTime(start + hour - 1);
        await record([
            event(
                {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
                },
                "acp",
            ),
        ]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("image")).commands[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + 2 * hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("image")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given replay, metadata, and another running command, When the old command becomes quiet, Then none renews its progress", async () => {
        const original = [requested("old"), started("old"), answer("Old progress")];
        await record(original);
        vi.setSystemTime(start + hour - 1);
        await record(original);
        await record([
            event({ sessionUpdate: "session_info_update", title: "Renamed" }, "acp"),
            requested("new"),
            started("new"),
            answer("New progress"),
        ]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        const state = await execution("old", "new");
        expect(state.commands.map((command) => command.attempt.kind)).toEqual(["indeterminate", "running"]);
        expect(state.activeCommands?.commandIds).toEqual(["new"]);
    });

    it("Given several pending requests, When they wait for hours and are answered separately, Then inactivity starts only after the last answer", async () => {
        await record([
            requested("waiting"),
            started("waiting"),
            permission("waiting", "one"),
            permission("waiting", "two"),
        ]);
        vi.setSystemTime(start + 4 * hour);
        await runDurableObjectAlarm(stub());
        expect((await execution("waiting")).commands[0]?.attempt.kind).toBe("waiting_input");
        await record([resolved("one")]);
        vi.setSystemTime(start + 5 * hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("waiting")).commands[0]?.attempt.kind).toBe("waiting_input");
        await record([resolved("two")]);
        vi.setSystemTime(start + 6 * hour + 1);
        expect((await execution("waiting")).commands[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + 6 * hour + 2);
        await runDurableObjectAlarm(stub());
        expect((await execution("waiting")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given a pending elicitation, When it waits for hours and is answered, Then only the subsequent execution can become inactive", async () => {
        await record([
            requested("form"),
            started("form"),
            event({
                kind: "session.elicitation.requested",
                event: {
                    accepted: true,
                    commandId: "form",
                    elicitationId: "form",
                    fields: [],
                    interactionId: "form-input",
                    kind: "session.elicitation.requested",
                    message: "Provide input",
                    mode: "form",
                    sessionId,
                    url: "",
                },
            }),
        ]);
        vi.setSystemTime(start + 4 * hour);
        await runDurableObjectAlarm(stub());
        expect((await execution("form")).commands[0]?.attempt).toMatchObject({
            interactionIds: ["form-input"],
            kind: "waiting_input",
        });
        await record([
            event({
                kind: "session.elicitation.resolved",
                event: {
                    action: "accept",
                    interactionId: "form-input",
                    kind: "session.elicitation.resolved",
                    sessionId,
                },
            }),
        ]);
        expect((await execution("form")).commands[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + 5 * hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("form")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given more due commands than one alarm can assess, When alarms run without history readers, Then every command becomes inactive and the alarm drains", async () => {
        const commandIds = Array.from({ length: 105 }, (_value, index) => `batch-${index}`);
        await record(commandIds.flatMap((commandId) => [requested(commandId), started(commandId)]));
        vi.setSystemTime(start + hour + 1);
        expect(await runDurableObjectAlarm(stub())).toBe(true);
        expect(await runDurableObjectAlarm(stub())).toBe(true);
        expect(await runDurableObjectAlarm(stub())).toBe(false);
        const state = await execution(commandIds[0] ?? "", commandIds.at(-1) ?? "");
        expect(state.commands.map((command) => command.attempt.kind)).toEqual(["indeterminate", "indeterminate"]);
        expect(state.activeCommands).toBeNull();
    });

    it("Given an inactive attempt, When new progress or a pending request arrives, Then it recovers and a later terminal result settles it", async () => {
        await record([requested("resume"), started("resume")]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("resume")).commands[0]?.attempt.kind).toBe("indeterminate");
        await record([answer("Resumed")]);
        expect((await execution("resume")).activeCommands?.commandIds).toEqual(["resume"]);
        expect((await read()).turns[0]?.attempt.kind).toBe("running");
        vi.setSystemTime(start + 2 * hour + 2);
        await runDurableObjectAlarm(stub());
        await record([permission("resume", "resume-permission")]);
        expect((await read()).turns[0]?.attempt.kind).toBe("waiting_input");
        await record([resolved("resume-permission"), completed("resume")]);
        vi.setSystemTime(start + 4 * hour);
        await runDurableObjectAlarm(stub());
        expect((await read()).turns[0]?.attempt.kind).toBe("succeeded");
    });

    it("Given inactive work, When its actual failure arrives, Then it replaces the diagnosis without changing its attempt identity", async () => {
        await record([requested("failed"), started("failed")]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        await record([
            event({
                kind: "prompt.failed",
                commandId: "failed",
                attemptId: "attempt-failed",
                code: "runtime_restarted",
                message: "Runtime restarted",
            }),
        ]);
        expect((await execution("failed")).commands[0]?.attempt).toMatchObject({
            attemptId: "attempt-failed",
            kind: "failed",
            code: "runtime_restarted",
        });
    });

    it("Given a generation change, When old-generation progress arrives late, Then it cannot revive the interrupted attempt", async () => {
        await record([requested("interrupted"), started("interrupted")]);
        generation = "generation-2";
        await record([requested("current"), started("current")]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        generation = "generation-1";
        await record([answer("Late old output")]);
        expect((await execution("interrupted")).commands[0]?.attempt).toMatchObject({
            kind: "indeterminate",
            reason: "session_generation_changed",
        });
    });

    it("Given an inactivity observation, When released and current decoders read the same response, Then old history stays readable and the new SDK exposes the diagnosis", async () => {
        await record([requested("compatible"), started("compatible"), answer("Retained output")]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        const response = await worker.fetch(new Request(path("turns")), env);
        const encoded = await response.text();
        const previous = decodePreviousTurnPage(encoded);
        expect(previous.turns[0]).toMatchObject({ attempt: { kind: "running" }, items: [{ text: "Retained output" }] });
        expect(decodeSessionRecordingTurnPage(encoded).turns[0]?.attempt.kind).toBe("indeterminate");
        expect(decodeSessionRecordingTurnPage(encodePreviousTurnPage(previous))).toEqual(previous);
        const facts = await worker.fetch(new Request(path("execution?commandId=compatible")), env);
        const executionWire = await facts.text();
        expect(decodePreviousExecution(executionWire).commands[0]?.attempt.kind).toBe("running");
        expect(decodeSessionRecordingExecution(executionWire).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it("Given an older projection and skewed runtime timestamps, When history is rebuilt, Then server-observed progress still has a bounded deadline", async () => {
        const request = requested("clock");
        const begin = { ...started("clock"), recordedAt: "2099-01-01T00:00:00.000Z" };
        await record([request, begin]);
        vi.setSystemTime(start + hour + 1);
        await runDurableObjectAlarm(stub());
        expect((await execution("clock")).commands[0]?.attempt.kind).toBe("indeterminate");
        await runInDurableObject(stub(), (_instance, state) => {
            state.storage.sql.exec(
                "UPDATE recording_projection SET state_json = json_remove(state_json, '$.activityVersion')",
            );
        });
        expect((await worker.fetch(new Request(path("turns")), env)).status).toBe(503);
        while (await runDurableObjectAlarm(stub())) {
            // Rebuild through the production bounded backfill alarm.
        }
        expect((await execution("clock")).commands[0]?.attempt.kind).toBe("indeterminate");
    });

    it.each(["1960-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])(
        "Given legacy batches without receipt times and a runtime clock at %s, When their projection is rebuilt, Then history remains readable and the deadline is bounded",
        async (recordedAt) => {
            await record([requested("legacy"), { ...started("legacy"), recordedAt }]);
            await runInDurableObject(stub(), (_instance, state) => {
                // An uncached ordinal models a batch stored before server receipt times existed.
                state.storage.sql.exec(
                    "UPDATE recorded_session_events_v2 SET received_at = NULL, ordinal = ordinal + 1",
                );
                state.storage.sql.exec(
                    "UPDATE recording_projection SET state_json = json_remove(state_json, '$.activityVersion')",
                );
            });
            expect((await worker.fetch(new Request(path("turns")), env)).status).toBe(503);
            await runDurableObjectAlarm(stub());
            vi.setSystemTime(start + 2 * hour);
            await runDurableObjectAlarm(stub());
            expect((await execution("legacy")).commands[0]?.attempt.kind).toBe("indeterminate");
        },
    );
});
