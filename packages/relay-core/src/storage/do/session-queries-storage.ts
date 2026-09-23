import { and, desc, eq, getTableColumns, lt, or } from "drizzle-orm";
import {
    type AttemptRecord,
    AttemptRecordSchema,
    type InteractionRecord,
    InteractionRecordSchema,
    type RuntimeIdentity,
    RuntimeIdentitySchema,
    SessionConfigurationRecordSchema,
    type SessionRecord,
    SessionRecordSchema,
    type TurnRecord,
    TurnRecordSchema,
} from "../../entity/do/session-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { sessions } from "../../schema/session-do/sessions.ts";
import { turns } from "../../schema/session-do/turns.ts";
import { decodeStorageRows } from "./decode-storage-rows.ts";

function _placeholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}

export class SessionQueriesStorage {
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }

    readonly findTurn = (scopeKey: string, sessionId: string, turnId: string): TurnRecord | undefined =>
        decodeStorageRows(
            TurnRecordSchema,
            this.#database.query(
                `SELECT * FROM turns
       WHERE scope_key = ? AND session_id = ? AND turn_id = ?`,
                [scopeKey, sessionId, turnId],
            ),
        )[0];

    readonly readConfiguration = (scopeKey: string, sessionId: string) =>
        decodeStorageRows(
            SessionConfigurationRecordSchema,
            this.#database.query(
                `SELECT config_options_json, config_revision, updated_at
                   FROM session_configuration_snapshots
                  WHERE scope_key = ? AND session_id = ?`,
                [scopeKey, sessionId],
            ),
        )[0];

    readonly findAttempt = (scopeKey: string, sessionId: string, attemptId: string): AttemptRecord | undefined =>
        decodeStorageRows(
            AttemptRecordSchema,
            this.#database.query(
                `SELECT * FROM attempts
       WHERE scope_key = ? AND session_id = ? AND attempt_id = ?`,
                [scopeKey, sessionId, attemptId],
            ),
        )[0];

    readonly findInteraction = (
        scopeKey: string,
        sessionId: string,
        interactionId: string,
    ): InteractionRecord | undefined =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT * FROM interactions
       WHERE scope_key = ? AND session_id = ? AND interaction_id = ?`,
                [scopeKey, sessionId, interactionId],
            ),
        )[0];

    readonly listPendingInteractions = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
    }): readonly InteractionRecord[] =>
        decodeStorageRows(
            InteractionRecordSchema,
            this.#database.query(
                `SELECT i.* FROM interactions i
       INNER JOIN attempts a
         ON a.scope_key = i.scope_key
        AND a.session_id = i.session_id
        AND a.attempt_id = i.attempt_id
       WHERE i.scope_key = ? AND i.session_id = ?
         AND i.state IN ('pending', 'responded')
         AND a.state = 'waiting_input'
       ORDER BY i.interaction_id
       LIMIT 101`,
                [input.scopeKey, input.sessionId],
            ),
        );

    readonly listSessions = (input: {
        readonly scopeKey: string;
        readonly limit: number;
        readonly cursor: {
            readonly updatedAt: number;
            readonly sessionId: string;
        } | null;
    }): readonly SessionRecord[] => {
        const latestTurnState = this.#database.orm
            .select({ state: turns.state })
            .from(turns)
            .where(and(eq(turns.scope_key, sessions.scope_key), eq(turns.session_id, sessions.session_id)))
            .orderBy(desc(turns.created_at), desc(turns.command_id))
            .limit(1)
            .as("latest_turn_state");
        const cursorFilter =
            input.cursor === null
                ? undefined
                : or(
                      lt(sessions.updated_at, input.cursor.updatedAt),
                      and(
                          eq(sessions.updated_at, input.cursor.updatedAt),
                          lt(sessions.session_id, input.cursor.sessionId),
                      ),
                  );
        return decodeStorageRows(
            SessionRecordSchema,
            this.#database.orm
                .select({ ...getTableColumns(sessions), latest_turn_state: latestTurnState })
                .from(sessions)
                .where(and(eq(sessions.scope_key, input.scopeKey), eq(sessions.lifecycle, "ready"), cursorFilter))
                .orderBy(desc(sessions.updated_at), desc(sessions.session_id))
                .limit(input.limit)
                .all(),
        );
    };

    readonly findTurnRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly turnId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM turns t
       INNER JOIN session_bindings b
         ON b.scope_key = t.scope_key AND b.session_id = t.session_id
        AND b.binding_id = t.binding_id
       WHERE t.scope_key = ? AND t.session_id = ? AND t.turn_id = ?`,
                [input.scopeKey, input.sessionId, input.turnId],
            ),
        )[0];
    readonly findCommandRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly commandId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM turns t
       INNER JOIN session_bindings b
         ON b.scope_key = t.scope_key AND b.session_id = t.session_id
        AND b.binding_id = t.binding_id
       WHERE t.scope_key = ? AND t.session_id = ? AND t.command_id = ?`,
                [input.scopeKey, input.sessionId, input.commandId],
            ),
        )[0];
    readonly findInteractionRuntime = (input: {
        readonly scopeKey: string;
        readonly sessionId: string;
        readonly interactionId: string;
    }): RuntimeIdentity | undefined =>
        decodeStorageRows(
            RuntimeIdentitySchema,
            this.#database.query(
                `SELECT b.runtime_id
       FROM interactions i
       INNER JOIN attempts a
         ON a.scope_key = i.scope_key AND a.session_id = i.session_id
        AND a.attempt_id = i.attempt_id
       INNER JOIN session_bindings b
         ON b.scope_key = a.scope_key AND b.session_id = a.session_id
        AND b.binding_id = a.binding_id
       WHERE i.scope_key = ? AND i.session_id = ? AND i.interaction_id = ?`,
                [input.scopeKey, input.sessionId, input.interactionId],
            ),
        )[0];
}
