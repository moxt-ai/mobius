import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionRecordingDurableObjectMigrations } from "../src/generated/session-recording-do-migrations.ts";
import { SessionRecordingStorage } from "../src/storage/session-recording-storage.ts";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

it("Given a Recording DO, When the retired message-ID migration is requested, Then it is not found", async () => {
    const stub = env.SESSION_RECORDING.getByName("retired-message-id-migration");
    const response = await stub.fetch("https://recording.internal/migrations/message-ids", {
        method: "POST",
        body: JSON.stringify({ mode: "apply" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
});

it("Given a pre-cleanup database with recorded events, When storage upgrades, Then bookkeeping tables disappear and event JSON survives unchanged", async () => {
    const stub = env.SESSION_RECORDING.getByName("retired-message-id-migration-upgrade");
    await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAll();
        const previous = sessionRecordingDurableObjectMigrations.filter(
            (migration) => !migration.name.startsWith("0010_"),
        );
        for (const migration of previous) {
            state.storage.sql.exec(migration.sql);
        }
        // Restore the persisted migration ledger of the previously deployed schema.
        state.storage.sql.exec(
            "CREATE TABLE recording_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
        );
        for (const migration of previous) {
            state.storage.sql.exec("INSERT INTO recording_schema_migrations VALUES (?, ?)", migration.name, Date.now());
        }
        const envelope = '{"kind":"session.event.v2","events":[],"futureField":"preserved"}';
        state.storage.sql.exec(
            "INSERT INTO recorded_session_events_v2 (envelope_json, recorded_at) VALUES (?, ?)",
            envelope,
            "2026-10-27T00:00:00.000Z",
        );
        new SessionRecordingStorage(state.storage);
        expect(
            state.storage.sql
                .exec(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('legacy_message_identities', 'message_id_migration')",
                )
                .toArray(),
        ).toEqual([]);
        expect(state.storage.sql.exec("SELECT envelope_json FROM recorded_session_events_v2").toArray()).toEqual([
            { envelope_json: envelope },
        ]);
    });
});
