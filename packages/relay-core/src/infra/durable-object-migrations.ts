import type { DoSqlDatabase } from "./do-sql-database.ts";

export interface DurableObjectMigration {
    readonly name: string;
    readonly sql: string;
    readonly existingState:
        | { readonly kind: "execute" }
        | { readonly kind: "adopt-table"; readonly table: string }
        | { readonly kind: "adopt-missing-table"; readonly table: string };
}

export function applyDurableObjectMigrations(
    database: DoSqlDatabase,
    namespace: string,
    migrations: readonly DurableObjectMigration[],
): void {
    database.run(`CREATE TABLE IF NOT EXISTS _mobius_do_schema_migrations (
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, name)
    ) STRICT;`);

    for (const migration of migrations) {
        const applied = database.query(
            "SELECT 1 AS present FROM _mobius_do_schema_migrations WHERE namespace = ? AND name = ?",
            [namespace, migration.name],
        )[0];
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
                    case "adopt-missing-table":
                        return (
                            database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [
                                migration.existingState.table,
                            ])[0] === undefined
                        );
                }
            })();
            if (!alreadySatisfied) {
                database.run(migration.sql);
            }
            database.run("INSERT INTO _mobius_do_schema_migrations (namespace, name, applied_at) VALUES (?, ?, ?)", [
                namespace,
                migration.name,
                Date.now(),
            ]);
        });
    }
}
