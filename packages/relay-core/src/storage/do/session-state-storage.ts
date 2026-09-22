import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { type SessionRecord, SessionRecordSchema } from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { sessions } from "../../schema/session-do/sessions.ts";
import { turns } from "../../schema/session-do/turns.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";

export class SessionStateStorage {
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        this.#database = cx.doDatabase;
    }

    readonly findSession = (scopeKey: string, sessionId: string): SessionRecord | undefined => {
        const latestTurnState = this.#database.orm
            .select({ state: turns.state })
            .from(turns)
            .where(and(eq(turns.scope_key, sessions.scope_key), eq(turns.session_id, sessions.session_id)))
            .orderBy(desc(turns.created_at), desc(turns.command_id))
            .limit(1)
            .as("latest_turn_state");
        return decodeStorageRows(
            SessionRecordSchema,
            this.#database.orm
                .select({ ...getTableColumns(sessions), latest_turn_state: latestTurnState })
                .from(sessions)
                .where(and(eq(sessions.scope_key, scopeKey), eq(sessions.session_id, sessionId)))
                .all(),
        )[0];
    };

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
