import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ExecutionReceiptTable } from "../../src/engine/storage/session/execution-receipt-table.ts";
import { openAcpSessionDatabase } from "../../src/engine/storage/sqlite/local-databases.ts";

// Existing databases were built from these committed migrations; do not derive them from the current list.
const migrationsThroughExecutionIdentity = [
    "0000_slimy_captain_midlands.sql",
    "0001_regular_ultimates.sql",
    "0002_equal_black_queen.sql",
    "0003_silky_ravenous.sql",
    "0004_special_mathemanic.sql",
    "0005_orange_amphibian.sql",
    "0006_live_event_position_allocation.sql",
    "0007_busy_excalibur.sql",
    "0008_execution_identity.sql",
];

/** A database as CLI 0.0.349 left it, or as a later release left it with admission order applied but unrecorded. */
function writeExistingDatabase(path: string, admissionOrder: boolean): void {
    const database = new DatabaseSync(path);
    try {
        for (const name of [
            ...migrationsThroughExecutionIdentity,
            ...(admissionOrder ? ["0009_receipt_admission_order.sql"] : []),
        ]) {
            database.exec(readFileSync(new URL(`../../migrations/acp-session-store/${name}`, import.meta.url), "utf8"));
        }
        database.exec("PRAGMA user_version = 9");
        const insert = database.prepare(
            `INSERT INTO execution_receipt
                (command_id, session_id, command_hash, attempt_id, state, started, outcome, updated_at)
             VALUES (?, 'session', 'hash', ?, 'succeeded', 1, NULL, ?)`,
        );
        insert.run("late", "attempt-late", "2026-10-28T10:00:00.000Z");
        insert.run("early", "attempt-early", "2026-10-28T09:00:00.000Z");
        if (admissionOrder) {
            database
                .prepare(
                    `INSERT INTO execution_receipt
                        (command_id, session_id, command_hash, attempt_id, admission_order, state, started, outcome,
                         updated_at)
                     VALUES ('ordered', 'session', 'hash', 'attempt-ordered', 7, 'running', 1, NULL, ?)`,
                )
                .run("2026-10-28T11:00:00.000Z");
        }
    } finally {
        database.close();
    }
}

test.each([
    { release: "CLI 0.0.349", admissionOrder: false, expected: ["early", "late"] },
    { release: "a later CLI", admissionOrder: true, expected: ["ordered", "early", "late"] },
])(
    "Given receipts in a database written by $release, When the Runtime opens it, Then every receipt has an admission order after the ordered ones, by last update",
    async ({ admissionOrder, expected }) => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-receipt-order-migration-"));
        const path = join(directory, "sessions.sqlite");
        try {
            writeExistingDatabase(path, admissionOrder);
            for (let reopen = 0; reopen < 2; reopen += 1) {
                const database = openAcpSessionDatabase(path);
                try {
                    const receipts = new ExecutionReceiptTable(database).list();
                    expect(receipts.map((receipt) => receipt.commandId)).toEqual(expected);
                    expect(new Set(receipts.map((receipt) => receipt.admissionOrder)).size).toBe(expected.length);
                } finally {
                    database.close();
                }
            }
            const migrated = new DatabaseSync(path);
            try {
                expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
                expect(
                    migrated
                        .prepare("SELECT name FROM pragma_table_info('execution_receipt') WHERE name = 'state'")
                        .get(),
                ).toBeUndefined();
            } finally {
                migrated.close();
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
