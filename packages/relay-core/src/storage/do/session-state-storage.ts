import { type SessionRecord, SessionRecordSchema } from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";

export class SessionStateStorage {
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }

    readonly findSession = (scopeKey: string, sessionId: string): SessionRecord | undefined =>
        decodeStorageRows(
            SessionRecordSchema,
            this.#database.query(
                `SELECT * FROM sessions
       WHERE scope_key = ? AND session_id = ?`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly markSessionDeleting = (input: {
        readonly deleteRequestedAt: number;
        readonly updatedAt: number;
        readonly scopeKey: string;
        readonly sessionId: string;
    }): { readonly changes: number } =>
        this.#database.run(
            `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
            [input.deleteRequestedAt, input.updatedAt, input.scopeKey, input.sessionId],
        );
}
