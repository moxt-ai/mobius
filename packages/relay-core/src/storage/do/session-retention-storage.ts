import { and, eq } from "drizzle-orm";
import type { SessionRetentionScope, SessionRetentionScrub } from "../../entity/do/session-retention-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import { attempts, interactions, pendingWork, sessions, turns } from "../../schema/session-do/index.ts";

export class SessionRetentionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly listNonRetainedSessions = (): readonly SessionRetentionScope[] =>
        this.#database.orm
            .select({ scopeKey: sessions.scope_key, sessionId: sessions.session_id, projectId: sessions.project_id })
            .from(sessions)
            .all();

    readonly readTurns = (scope: SessionRetentionScope) =>
        this.#database.orm
            .select({
                id: turns.command_id,
                turnId: turns.turn_id,
                state: turns.state,
                commandJson: turns.command_json,
            })
            .from(turns)
            .where(and(eq(turns.scope_key, scope.scopeKey), eq(turns.session_id, scope.sessionId)))
            .all();

    readonly readAttempts = (scope: SessionRetentionScope) =>
        this.#database.orm
            .select({ id: attempts.attemptId, turnId: attempts.turnId, state: attempts.state })
            .from(attempts)
            .where(and(eq(attempts.scopeKey, scope.scopeKey), eq(attempts.sessionId, scope.sessionId)))
            .all();

    readonly readContent = (scope: SessionRetentionScope) => {
        const database = this.#database.orm;
        return {
            turns: this.readTurns(scope),
            attempts: this.readAttempts(scope),
            interactions: database
                .select({ id: interactions.interactionId, state: interactions.state })
                .from(interactions)
                .where(and(eq(interactions.scopeKey, scope.scopeKey), eq(interactions.sessionId, scope.sessionId)))
                .all(),
            work: database
                .select({ id: pendingWork.workId, state: pendingWork.state })
                .from(pendingWork)
                .where(and(eq(pendingWork.scopeKey, scope.scopeKey), eq(pendingWork.sessionId, scope.sessionId)))
                .all(),
        };
    };

    readonly scrubContent = (scope: SessionRetentionScope, scrub: SessionRetentionScrub): void => {
        this.#database.transaction(() => {
            const database = this.#database.orm;
            if (!this.isNonRetained(scope)) {
                return;
            }
            this.replaceTurnContent(scope, scrub.turns, scrub.attemptIds);
            for (const id of scrub.interactionIds) {
                database
                    .delete(interactions)
                    .where(
                        and(
                            eq(interactions.scopeKey, scope.scopeKey),
                            eq(interactions.sessionId, scope.sessionId),
                            eq(interactions.interactionId, id),
                        ),
                    )
                    .run();
            }
            for (const id of scrub.workIds) {
                database
                    .update(pendingWork)
                    .set({ deliveryPayload: null, errorMessage: null })
                    .where(
                        and(
                            eq(pendingWork.scopeKey, scope.scopeKey),
                            eq(pendingWork.sessionId, scope.sessionId),
                            eq(pendingWork.workId, id),
                        ),
                    )
                    .run();
            }
            database
                .update(sessions)
                .set({ title: "" })
                .where(and(eq(sessions.scope_key, scope.scopeKey), eq(sessions.session_id, scope.sessionId)))
                .run();
        });
    };

    private readonly isNonRetained = (scope: SessionRetentionScope): boolean =>
        this.#database.orm
            .select({ id: sessions.session_id })
            .from(sessions)
            .where(
                and(
                    eq(sessions.scope_key, scope.scopeKey),
                    eq(sessions.session_id, scope.sessionId),
                    eq(sessions.project_id, scope.projectId),
                ),
            )
            .get() !== undefined;

    private readonly replaceTurnContent = (
        scope: SessionRetentionScope,
        commands: SessionRetentionScrub["turns"],
        attemptIds: readonly string[],
    ): void => {
        const database = this.#database.orm;
        for (const turn of commands) {
            database
                .update(turns)
                .set({ command_json: turn.commandJson, error_message: null, response: "" })
                .where(
                    and(
                        eq(turns.scope_key, scope.scopeKey),
                        eq(turns.session_id, scope.sessionId),
                        eq(turns.command_id, turn.id),
                    ),
                )
                .run();
        }
        for (const id of attemptIds) {
            database
                .update(attempts)
                .set({ errorMessage: null })
                .where(
                    and(
                        eq(attempts.scopeKey, scope.scopeKey),
                        eq(attempts.sessionId, scope.sessionId),
                        eq(attempts.attemptId, id),
                    ),
                )
                .run();
        }
    };
}
