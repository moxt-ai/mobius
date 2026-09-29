export interface DurableObjectSqlMigration {
    readonly name: string;
    readonly sql: string;
}

export function applyDurableObjectMigrations(
    storage: DurableObjectStorage,
    migrations: readonly DurableObjectSqlMigration[],
): void {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS recording_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
    ) STRICT;`);
    for (const migration of migrations) {
        const applied = storage.sql
            .exec("SELECT 1 AS present FROM recording_schema_migrations WHERE name = ?", migration.name)
            .toArray()[0];
        if (applied !== undefined) {
            continue;
        }
        storage.transactionSync(() => {
            storage.sql.exec(migration.sql);
            storage.sql.exec(
                "INSERT INTO recording_schema_migrations (name, applied_at) VALUES (?, ?)",
                migration.name,
                Date.now(),
            );
        });
    }
}
