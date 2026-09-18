import { ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import type { DoSqlDatabase, DoSqlRow } from "../../infra/do-sql-database.ts";

function text(row: DoSqlRow, key: string): string {
    const value = row[key];
    if (typeof value !== "string") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session recovery record is invalid");
    }
    return value;
}

export class SessionRecoveryStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly list = () =>
        this.#database
            .query(`SELECT project_id, session_id, lifecycle
        FROM sessions WHERE lifecycle <> 'deleted'`)
            .map((row) => ({
                scope: new ProjectScope(text(row, "project_id")),
                sessionId: text(row, "session_id"),
                lifecycle: text(row, "lifecycle"),
            }));
}
