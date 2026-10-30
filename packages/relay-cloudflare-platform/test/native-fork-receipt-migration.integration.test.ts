import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { runtimeConnectionDurableObjectMigrations } from "../../relay-core/src/generated/runtime-connection-do-migrations.ts";
import { NativeSessionForkStorage } from "../../relay-core/src/storage/native-session-fork-storage.ts";
import { RuntimeConnectionStorage } from "../../relay-core/src/storage/runtime-connection-storage.ts";

afterEach(() => vi.useRealTimers());
afterAll(async () => await abortAllDurableObjects());

it("Given pre-recovery Fork receipts, When upgraded and written by either deployment, Then completed results and unknown attempts retain their meaning", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T02:00:00Z"), toFake: ["Date"] });
    await runInDurableObject(
        env.RUNTIME_RELAY.getByName(`fork-migration-${crypto.randomUUID()}`),
        (_instance, state) => {
            // Retained 7110e99 schema and read/write contract, independent of the current Drizzle model.
            state.storage.sql.exec("DROP TABLE native_session_forks");
            const legacySchema = runtimeConnectionDurableObjectMigrations.find(
                (migration) => migration.name === "0005_glamorous_stick.sql",
            );
            if (legacySchema === undefined) {
                throw new Error("Missing retained schema");
            }
            state.storage.sql.exec(legacySchema.sql);
            // The 0005 schema still had the Runtime revocation table that a later migration drops.
            const revocations = runtimeConnectionDurableObjectMigrations
                .find((migration) => migration.name === "0000_nebulous_molten_man.sql")
                ?.sql.split("--> statement-breakpoint")
                .find((statement) => statement.includes("CREATE TABLE `runtime_revocations`"));
            if (revocations === undefined) {
                throw new Error("Missing retained Runtime revocation schema");
            }
            state.storage.sql.exec(revocations);
            state.storage.sql.exec(
                "DELETE FROM _mobius_do_schema_migrations WHERE namespace = 'runtime-connection-do' AND name > '0005_glamorous_stick.sql'",
            );
            const oldWrite = (id: string, result: string | null) =>
                state.storage.sql.exec(
                    "INSERT INTO native_session_forks (project_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?)",
                    "project",
                    id,
                    "hash",
                    result,
                );
            const oldRead = (id: string) =>
                state.storage.sql
                    .exec(
                        "SELECT request_hash, result_json FROM native_session_forks WHERE project_id = ? AND operation_id = ?",
                        "project",
                        id,
                    )
                    .one();
            const completed = JSON.stringify({ source: "original source", result: "original result" });
            oldWrite("old-completed", completed);
            oldWrite("old-unknown", null);
            const database = new DurableObjectSqlDatabase(state.storage);
            new RuntimeConnectionStorage(database);
            const receipts = new NativeSessionForkStorage(database);
            expect(receipts.read("project", "old-completed")).toEqual({
                requestHash: "hash",
                resultJson: completed,
                attemptJson: null,
            });
            expect(receipts.read("project", "old-unknown")).toEqual({
                requestHash: "hash",
                resultJson: null,
                attemptJson: null,
            });
            const attempt = JSON.stringify({ source: "resolved source", targetSessionId: "first-target" });
            receipts.start("project", "new", "hash", attempt);
            expect(oldRead("new")).toEqual({ request_hash: "hash", result_json: null });
            expect(receipts.read("project", "new")?.attemptJson).toBe(attempt);
            receipts.complete("project", "new", completed);
            expect(oldRead("new")).toEqual({ request_hash: "hash", result_json: completed });
            expect(receipts.read("project", "new")?.attemptJson).toBeNull();
            oldWrite("rollback-unknown", null);
            expect(receipts.read("project", "rollback-unknown")).toEqual({
                requestHash: "hash",
                resultJson: null,
                attemptJson: null,
            });
        },
    );
});
