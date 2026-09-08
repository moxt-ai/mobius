import { SessionCountSchema, type SessionRecord, SessionRecordSchema } from "../../entity/session/session-records.ts";
import { decodeStorageRecord, decodeStorageRows } from "./decode-storage-rows.ts";
import type { SessionSqlDatabase } from "./session-sql-database.ts";

export class SessionStateStorage {
    readonly #database: SessionSqlDatabase;
    constructor(cx: { readonly gateways: { readonly database: SessionSqlDatabase } }) {
        const { database } = cx.gateways;
        this.#database = database;
    }

    readonly countTenantSessions = (tenantId: string): number =>
        decodeStorageRecord(
            SessionCountSchema,
            this.#database.query(
                `SELECT COUNT(*) AS active_sessions FROM sessions
       WHERE tenant_id = ? AND lifecycle <> 'deleted'`,
                [tenantId],
            )[0],
        ).active_sessions;

    readonly countProjectSessions = (tenantId: string, projectId: string): number =>
        decodeStorageRecord(
            SessionCountSchema,
            this.#database.query(
                `SELECT COUNT(*) AS active_sessions FROM sessions
       WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'`,
                [tenantId, projectId],
            )[0],
        ).active_sessions;

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
