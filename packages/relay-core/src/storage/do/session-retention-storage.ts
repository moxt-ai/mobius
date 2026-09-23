import { and, eq, gte, lt } from "drizzle-orm";
import type {
    SessionRetentionReceipt,
    SessionRetentionScope,
    SessionRetentionScrub,
} from "../../entity/do/session-retention-records.ts";
import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
import {
    archiveSegments,
    archiveWork,
    artifacts,
    attempts,
    immutableContent,
    interactions,
    pendingWork,
    sessionContentChunks,
    sessionEventReceipts,
    sessionEvents,
    sessionMessageChunks,
    sessionMessages,
    sessionStreamBlocks,
    sessionStreamEventRefs,
    sessionStreams,
    sessions,
    toolCallNarrations,
    toolCallViews,
    turnContentViews,
    turnMessageAnchors,
    turns,
    uploadedArtifacts,
} from "../../schema/session-do/index.ts";

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
            events: database
                .select({
                    scopeKey: sessionEvents.scopeKey,
                    sessionId: sessionEvents.sessionId,
                    eventId: sessionEvents.eventId,
                    payloadHash: sessionEvents.payloadHash,
                    recordedAt: sessionEvents.recordedAt,
                    sequenceNumber: sessionEvents.sequenceNumber,
                    sourceId: sessionEvents.sourceId,
                    sourceKind: sessionEvents.sourceKind,
                    sourceSeq: sessionEvents.sourceSeq,
                })
                .from(sessionEvents)
                .where(and(eq(sessionEvents.scopeKey, scope.scopeKey), eq(sessionEvents.sessionId, scope.sessionId)))
                .all(),
            receipts: database
                .select()
                .from(sessionEventReceipts)
                .where(
                    and(
                        eq(sessionEventReceipts.scopeKey, scope.scopeKey),
                        eq(sessionEventReceipts.sessionId, scope.sessionId),
                    ),
                )
                .all(),
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
            for (const receipt of scrub.receipts) {
                this.writeReceipt(scope, receipt);
            }
            for (const table of [
                archiveSegments,
                archiveWork,
                artifacts,
                sessionContentChunks,
                sessionEvents,
                sessionMessageChunks,
                sessionMessages,
                sessionStreamBlocks,
                sessionStreamEventRefs,
                sessionStreams,
                toolCallViews,
                toolCallNarrations,
                turnContentViews,
                turnMessageAnchors,
                uploadedArtifacts,
            ]) {
                database
                    .delete(table)
                    .where(and(eq(table.scopeKey, scope.scopeKey), eq(table.sessionId, scope.sessionId)))
                    .run();
            }
            // SQLite content keys are project/session/artifact. A lexical prefix range keeps
            // underscores in identifiers literal, unlike a SQL LIKE pattern.
            const prefix = `${scope.projectId}/${scope.sessionId}/`;
            database
                .delete(immutableContent)
                .where(and(gte(immutableContent.objectKey, prefix), lt(immutableContent.objectKey, `${prefix}\uffff`)))
                .run();
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
                .set({ native_history_json: null, title: "" })
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

    private readonly writeReceipt = (scope: SessionRetentionScope, receipt: SessionRetentionReceipt): void => {
        this.#database.orm
            .insert(sessionEventReceipts)
            .values({ ...receipt, scopeKey: scope.scopeKey, sessionId: scope.sessionId })
            .onConflictDoUpdate({
                target: [
                    sessionEventReceipts.scopeKey,
                    sessionEventReceipts.sessionId,
                    sessionEventReceipts.sourceKind,
                    sessionEventReceipts.sourceId,
                ],
                set: {
                    eventId: receipt.eventId,
                    payloadHash: receipt.payloadHash,
                    recordedAt: receipt.recordedAt,
                    sequenceNumber: receipt.sequenceNumber,
                    sourceSeq: receipt.sourceSeq,
                },
            })
            .run();
    };
}
