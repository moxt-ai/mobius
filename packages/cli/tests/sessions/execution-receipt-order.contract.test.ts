import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ExecutionReceiptTable } from "../../src/engine/storage/session/execution-receipt-table.ts";
import { openAcpSessionDatabase } from "../../src/engine/storage/sqlite/local-databases.ts";

// Independently retained CLI 0.0.348 storage contract (bf782ed9), including its reader version gate.
// Historical migrations are immutable; do not derive this baseline from the current migration list.
function openLegacyDatabase(path: string): DatabaseSync {
    const database = new DatabaseSync(path);
    const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
    if (typeof version !== "number" || version > 9) {
        database.close();
        throw new Error("The ACP Session database was created by a newer Mobius version");
    }
    if (version === 0) {
        for (const name of [
            "0000_slimy_captain_midlands.sql",
            "0001_regular_ultimates.sql",
            "0002_equal_black_queen.sql",
            "0003_silky_ravenous.sql",
            "0004_special_mathemanic.sql",
            "0005_orange_amphibian.sql",
            "0006_live_event_position_allocation.sql",
            "0007_busy_excalibur.sql",
            "0008_execution_identity.sql",
        ]) {
            database.exec(readFileSync(new URL(`../../migrations/acp-session-store/${name}`, import.meta.url), "utf8"));
        }
        database.exec("PRAGMA user_version = 9");
    }
    return database;
}

const completed = (commandId: string) =>
    JSON.stringify({
        type: "lifecycle-metadata",
        payload: { kind: "prompt.completed", commandId, stopReason: "end_turn" },
        recordedAt: "2026-10-28T10:00:00.000Z",
    });

function writeLegacyReceipt(database: DatabaseSync, commandId: string, updatedAt: string): void {
    database
        .prepare(
            `INSERT INTO execution_receipt
                (command_id, session_id, command_hash, attempt_id, state, started, outcome, updated_at)
             VALUES (?, 'session', 'hash', ?, 'succeeded', 1, ?, ?)
             ON CONFLICT (command_id) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at`,
        )
        .run(commandId, `attempt-${commandId}`, completed(commandId), updatedAt);
}

test("Given pre-order receipts, When the Runtime upgrades, rolls back and upgrades again, Then legacy outcomes remain readable and known admission order survives legacy writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-receipt-order-compatibility-"));
    const path = join(directory, "sessions.sqlite");
    try {
        const legacy = openLegacyDatabase(path);
        try {
            writeLegacyReceipt(legacy, "first", "2026-10-28T09:00:00.000Z");
            writeLegacyReceipt(legacy, "second", "2026-10-28T10:00:00.000Z");
        } finally {
            legacy.close();
        }

        const upgraded = openAcpSessionDatabase(path);
        try {
            const receipts = new ExecutionReceiptTable(upgraded);
            const rows = receipts.list();
            expect(rows.map((row) => [row.commandId, row.outcome])).toEqual([
                ["first", completed("first")],
                ["second", completed("second")],
            ]);
            // A new writer's update must remain readable by the released reader after rollback.
            const first = rows[0];
            if (first === undefined) {
                throw new Error("Expected the legacy receipt");
            }
            receipts.save({ ...first, updatedAt: "2026-10-28T11:00:00.000Z" }, 1_024);
        } finally {
            upgraded.close();
        }

        const rollback = openLegacyDatabase(path);
        try {
            expect(
                rollback
                    .prepare("SELECT state, started, outcome FROM execution_receipt WHERE command_id = 'first'")
                    .get(),
            ).toEqual({ state: "succeeded", started: 1, outcome: completed("first") });
            writeLegacyReceipt(rollback, "first", "2026-10-28T12:00:00.000Z");
            // Old writers omit the new column, including when their clock is behind existing rows.
            writeLegacyReceipt(rollback, "third", "2026-10-28T08:00:00.000Z");
        } finally {
            rollback.close();
        }

        for (let reopen = 0; reopen < 2; reopen += 1) {
            const database = openAcpSessionDatabase(path);
            try {
                expect(new ExecutionReceiptTable(database).list().map((row) => [row.commandId, row.outcome])).toEqual([
                    ["first", completed("first")],
                    ["second", completed("second")],
                    ["third", completed("third")],
                ]);
            } finally {
                database.close();
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
