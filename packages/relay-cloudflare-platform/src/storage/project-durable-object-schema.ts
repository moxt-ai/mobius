import type { DoSqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { projectDurableObjectMigrations } from "../generated/project-do-migrations.ts";

interface ProjectDurableObjectMigration {
    readonly name: string;
    readonly sql: string;
    readonly existingState: { readonly kind: "execute" } | { readonly kind: "adopt-table"; readonly table: string };
}

export function initializeProjectDurableObjectSchema(database: DoSqlDatabase): void {
    database.run(`CREATE TABLE IF NOT EXISTS project_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    ) STRICT;`);
    const migrations: readonly ProjectDurableObjectMigration[] = projectDurableObjectMigrations;
    for (const migration of migrations) {
        const applied = database.query("SELECT 1 AS present FROM project_schema_migrations WHERE name = ?", [
            migration.name,
        ])[0];
        if (applied !== undefined) {
            continue;
        }
        database.transaction(() => {
            const alreadySatisfied = (() => {
                switch (migration.existingState.kind) {
                    case "execute":
                        return false;
                    case "adopt-table":
                        return (
                            database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [
                                migration.existingState.table,
                            ])[0] !== undefined
                        );
                }
            })();
            if (!alreadySatisfied) {
                database.run(migration.sql);
            }
            database.run("INSERT INTO project_schema_migrations (name, applied_at) VALUES (?, ?)", [
                migration.name,
                Date.now(),
            ]);
        });
    }
}
