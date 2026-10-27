import type { DoSqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { projectDurableObjectMigrations } from "../generated/project-do-migrations.ts";
import { migrateRuntimePairingRecords } from "./migrate-runtime-pairing-records.ts";

export function initializeProjectDurableObjectSchema(database: DoSqlDatabase): void {
    database.run(`CREATE TABLE IF NOT EXISTS project_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    ) STRICT;`);
    for (const migration of projectDurableObjectMigrations) {
        const applied = database.query("SELECT 1 AS present FROM project_schema_migrations WHERE name = ?", [
            migration.name,
        ])[0];
        if (applied !== undefined) {
            continue;
        }
        database.transaction(() => {
            if (migration.name === "0005_drop_pairing_channels.sql") {
                migrateRuntimePairingRecords(database);
            }
            database.run(migration.sql);
            database.run("INSERT INTO project_schema_migrations (name, applied_at) VALUES (?, ?)", [
                migration.name,
                Date.now(),
            ]);
        });
    }
}
