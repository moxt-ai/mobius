import { sessionDurableObjectMigrations } from "../../generated/session-do-migrations.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { applyDurableObjectMigrations } from "../../infra/durable-object-migrations.ts";

export function initializeSessionSchema(database: DoSqlDatabase): void {
    applyDurableObjectMigrations(database, "session-do", sessionDurableObjectMigrations);
}
