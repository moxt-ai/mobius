import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { decodeSessionRecordingHistoryPage } from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageIdMigrationWorker } from "../src/message-id-migration-worker.ts";
import { createRecordingWorker } from "../src/worker.ts";

const recording = createRecordingWorker();
const migration = createMessageIdMigrationWorker();
const token = "test-message-id-migration-token-0000000000";
let sequence = 0;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function fixture() {
    const projectId = `migration-project-${++sequence}`;
    const runtimeId = "migration-runtime";
    const sessionId = "migration-session";
    const stub = env.SESSION_RECORDING.getByName(JSON.stringify([projectId, sessionId]));
    let position = 0;
    const event = (payload: unknown, type = "acp", generation = "generation-1") => ({
        eventId: `event-${++position}`,
        payload,
        position: String(position),
        recordedAt: "2026-10-27T00:00:00.000Z",
        sessionGenerationId: generation,
        sessionId,
        type,
    });
    const chunk = (sessionUpdate: string, messageId?: string | null, generation?: string) =>
        event(
            {
                content: { text: "hello", type: "text" },
                sessionUpdate,
                ...(messageId === undefined ? {} : { messageId }),
            },
            "acp",
            generation,
        );
    const record = async (events: readonly unknown[]) => {
        const response = await recording.fetch(
            new Request("https://recording.internal/v1/session-events", {
                method: "POST",
                body: JSON.stringify({ projectId, runtimeId, envelope: { kind: "session.event.v2", events } }),
            }),
            env,
        );
        expect(response.status).toBe(201);
    };
    const read = async (suffix = "events") =>
        await recording.fetch(
            new Request(
                `https://recording.internal/v1/projects/${projectId}/runtimes/${runtimeId}/sessions/${sessionId}/${suffix}`,
            ),
            env,
        );
    const step = async (body: unknown = { mode: "apply" }, authorization = token) =>
        await migration.fetch(
            new Request(`https://migration.test/sessions/${stub.id.toString()}`, {
                method: "POST",
                headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
            { ...env, MIGRATION_TOKEN: token },
        );
    return { stub, event, chunk, record, read, step };
}

describe("Recording message identity migration", () => {
    it("Given protocol-valid empty and whitespace message IDs, When migration and subsequent writes run, Then supplied strings survive unchanged", async () => {
        const f = fixture();
        const supplied = [
            f.chunk("user_message_chunk", ""),
            f.chunk("agent_message_chunk", " "),
            f.chunk("agent_thought_chunk", "\t"),
        ];
        await f.record(supplied);
        expect(await (await f.step({ mode: "dry-run", afterOrdinal: 0 })).json()).toMatchObject({ missingEvents: 0 });
        const applied = await f.step();
        expect(applied.status).toBe(200);
        expect(await applied.json()).toMatchObject({ kind: "complete", rewrittenEvents: 0 });
        const subsequent = [
            f.chunk("user_message_chunk", ""),
            f.chunk("agent_message_chunk", " "),
            f.chunk("agent_thought_chunk", "\t"),
        ];
        await f.record(subsequent);
        expect(await (await f.read()).json()).toMatchObject({ events: [...supplied, ...subsequent] });
    });
    it("Given legacy chunks, When an operator previews and applies the migration, Then only the three chunk variants gain identities and raw cursors and unrelated fields survive", async () => {
        const f = fixture();
        const original = [
            f.chunk("user_message_chunk"),
            f.chunk("agent_thought_chunk", null),
            f.chunk("agent_message_chunk"),
            f.chunk("agent_message_chunk", "native-message"),
            f.event({ sessionUpdate: "session_info_update", title: "Keep title" }),
            f.event({ commandId: "command-1", kind: "prompt.completed", stopReason: "end_turn" }, "lifecycle-metadata"),
        ];
        await f.record(original);
        await runInDurableObject(f.stub, (_instance, state) => {
            state.storage.sql.exec(
                "UPDATE recorded_session_events_v2 SET envelope_json = json_set(envelope_json, '$.futureEnvelope', 7, '$.events[0].futureEvent', 8, '$.events[0].payload.futurePayload', 9)",
            );
        });
        const beforeRaw = await (await f.read("events?after=0&limit=1000")).json();
        const before = decodeSessionRecordingHistoryPage(JSON.stringify(beforeRaw));
        const preview = await f.step({ mode: "dry-run", afterOrdinal: 0 });
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({
            kind: "dry-run",
            missingEvents: 3,
            affectedBatches: 1,
            hasMore: false,
        });
        expect(await (await f.read("events?after=0&limit=1000")).json()).toEqual(beforeRaw);
        const applied = await f.step();
        expect(applied.status).toBe(200);
        expect(await applied.json()).toMatchObject({ kind: "complete", rewrittenEvents: 3, rewrittenBatches: 1 });
        const afterRaw = await (await f.read("events?after=0&limit=1000")).json();
        const after = decodeSessionRecordingHistoryPage(JSON.stringify(afterRaw));
        expect(after).toMatchObject({ tailCursor: before.tailCursor, nextCursor: before.nextCursor });
        expect(
            after.events
                .slice(0, 3)
                .every((e) => e.type === "acp" && "messageId" in e.payload && typeof e.payload.messageId === "string"),
        ).toBe(true);
        expect(after.events.slice(3)).toEqual(original.slice(3));
        const raw = await runInDurableObject(f.stub, (_instance, state) =>
            state.storage.sql
                .exec<{ envelope_json: string }>("SELECT envelope_json FROM recorded_session_events_v2")
                .one(),
        );
        expect(JSON.parse(raw.envelope_json)).toMatchObject({
            futureEnvelope: 7,
            events: expect.arrayContaining([
                { ...original[0], futureEvent: 8, payload: expect.objectContaining({ futurePayload: 9 }) },
            ]),
        });
        await f.step();
        expect(await (await f.read("events?after=0&limit=1000")).json()).toEqual(afterRaw);
    });

    it("Given streamed legacy chunks across bounded steps and duplicate frames, When migration resumes and live output continues, Then identities stay grouped, duplicate identities agree, and turn history is rebuilt", async () => {
        const f = fixture();
        await f.record([
            f.event(
                { commandId: "command-1", content: [{ text: "Hi", type: "text" }], kind: "prompt.requested" },
                "lifecycle-metadata",
            ),
            f.event(
                { attemptId: "attempt-1", commandId: "command-1", epoch: "epoch-1", kind: "prompt.started" },
                "lifecycle-metadata",
            ),
        ]);
        const first = f.chunk("agent_message_chunk");
        await f.record([first]);
        for (let index = 0; index < 9; index++) {
            await f.record([f.chunk("agent_message_chunk", null)]);
        }
        expect((await f.read("turns")).status).toBe(200);
        const partial = await f.step();
        expect(partial.status).toBe(200);
        expect(await partial.json()).toMatchObject({ kind: "running" });
        expect((await f.read("turns")).status).toBe(503);
        await f.record([f.chunk("agent_message_chunk")]);
        const finished = await f.step();
        expect(await finished.json()).toMatchObject({ kind: "complete" });
        await f.record([first]);
        await f.record([f.chunk("agent_message_chunk")]);
        const raw = decodeSessionRecordingHistoryPage(await (await f.read("events?after=0&limit=1000")).text());
        const chunks = raw.events.filter((e) => e.type === "acp");
        expect(new Set(chunks.map((e) => ("messageId" in e.payload ? e.payload.messageId : undefined))).size).toBe(1);
        while (await runDurableObjectAlarm(f.stub)) {
            /* Drain bounded production backfill. */
        }
        const turns = await f.read("turns");
        expect(turns.status).toBe(200);
        expect(await turns.json()).toMatchObject({
            turns: [{ answerLength: 60, items: [{ kind: "answer", text: "hello".repeat(12) }] }],
        });
    });

    it("Given legacy chunks separated by kind, native identity, lifecycle, or generation, When migrated, Then synthetic groups do not cross these boundaries", async () => {
        const f = fixture();
        await f.record([
            f.chunk("agent_message_chunk"),
            f.chunk("agent_message_chunk"),
            f.chunk("agent_thought_chunk"),
            f.chunk("agent_message_chunk"),
            f.chunk("agent_message_chunk", "native"),
            f.chunk("agent_message_chunk"),
            f.event({ commandId: "command-1", kind: "prompt.completed", stopReason: "end_turn" }, "lifecycle-metadata"),
            f.chunk("agent_message_chunk"),
            f.chunk("agent_message_chunk", null, "generation-2"),
        ]);
        expect((await f.step()).status).toBe(200);
        const raw = decodeSessionRecordingHistoryPage(await (await f.read("events?after=0&limit=1000")).text());
        const ids = raw.events
            .filter((e) => e.type === "acp")
            .map((e) => ("messageId" in e.payload ? e.payload.messageId : undefined));
        expect(ids[0]).toBe(ids[1]);
        expect(new Set(ids).size).toBe(7);
        expect(ids[4]).toBe("native");
    });

    it("Given unauthorized or malformed migration requests, When submitted, Then no stored chunk is changed", async () => {
        const f = fixture();
        await f.record([f.chunk("agent_message_chunk")]);
        const before = await (await f.read()).json();
        expect((await f.step({ mode: "apply" }, "wrong-token")).status).toBe(403);
        expect((await f.step({ mode: "unknown" })).status).toBe(400);
        expect(await (await f.read()).json()).toEqual(before);
        const direct = await f.stub.fetch("https://recording.internal/migrations/message-ids", {
            method: "POST",
            body: JSON.stringify({ mode: "apply" }),
        });
        expect(direct.status).toBe(403);
    });

    it("Given a corrupt stored batch, When a migration step fails, Then earlier rewrites in that step roll back and a repaired retry resumes safely", async () => {
        const f = fixture();
        await f.record([f.chunk("agent_message_chunk")]);
        await f.record([f.chunk("agent_message_chunk")]);
        const saved = await runInDurableObject(f.stub, (_instance, state) => {
            const row = state.storage.sql
                .exec<{ envelope_json: string }>(
                    "SELECT envelope_json FROM recorded_session_events_v2 WHERE ordinal = 2",
                )
                .one();
            state.storage.sql.exec("UPDATE recorded_session_events_v2 SET envelope_json = '{}' WHERE ordinal = 2");
            return row.envelope_json;
        });
        const failed = await f.step();
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({ error: { code: "message_id_migration_invalid_data" } });
        await runInDurableObject(f.stub, (_instance, state) => {
            state.storage.sql.exec("UPDATE recorded_session_events_v2 SET envelope_json = ? WHERE ordinal = 2", saved);
        });
        const raw = decodeSessionRecordingHistoryPage(await (await f.read("events?after=0&limit=1000")).text());
        expect(raw.events.every((event) => !("messageId" in event.payload))).toBe(true);
        expect(await (await f.step()).json()).toMatchObject({ kind: "complete", rewrittenEvents: 2 });
    });

    it("Given more legacy batches than one step can migrate, When the operator starts work and disconnects, Then alarms complete the migration and a later request reports completion", async () => {
        const f = fixture();
        for (let index = 0; index < 10; index++) {
            await f.record([f.chunk("user_message_chunk")]);
        }
        expect(await (await f.step()).json()).toMatchObject({ kind: "running" });
        while (await runDurableObjectAlarm(f.stub)) {
            // Exercise the deployed continuation boundary rather than an operator polling loop.
        }
        expect(await (await f.step()).json()).toMatchObject({ kind: "complete", rewrittenEvents: 10 });
        const page = decodeSessionRecordingHistoryPage(await (await f.read("events?after=0&limit=1000")).text());
        expect(
            page.events.every(
                (event) =>
                    event.type === "acp" && "messageId" in event.payload && typeof event.payload.messageId === "string",
            ),
        ).toBe(true);
    });
});
