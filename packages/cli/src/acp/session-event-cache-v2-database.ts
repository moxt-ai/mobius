import { decodeSessionEventV2, type SessionEventV2 } from "@moxt-ai/mobius-protocol";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionEventV2 } from "../schema/session-event-cache/index.ts";

const cachedEventRowSchema = z.object({ eventJson: z.string(), ordinal: z.number().int().positive() });

interface SessionEventCacheV2Batch {
    readonly events: readonly SessionEventV2[];
    readonly firstOrdinal: number;
    readonly sessionGenerationId: string;
    readonly sessionId: string;
}

export class SessionEventCacheV2Database {
    readonly #database: NodeSQLiteDatabase;
    readonly #databaseOrdinalsBySession = new Map<string, Map<string, number>>();
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #localDatabase: LocalSqliteDatabase;
    #isAvailable = true;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEventV2).run());
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    get isAvailable(): boolean {
        return this.#isAvailable;
    }

    readonly replace = (sessionId: string, sessionGenerationId: string, event: SessionEventV2): void => {
        if (!this.#isAvailable) {
            return;
        }
        const ordinal = this.#databaseOrdinalsBySession.get(sessionId)?.get(event.eventId);
        if (ordinal === undefined) {
            return;
        }
        try {
            this.#database
                .update(sessionEventV2)
                .set({ eventJson: JSON.stringify(event) })
                .where(
                    and(
                        eq(sessionEventV2.generationId, sessionGenerationId),
                        eq(sessionEventV2.sessionId, sessionId),
                        eq(sessionEventV2.ordinal, ordinal),
                    ),
                )
                .run();
        } catch (cause) {
            this.#disableWrites(cause);
        }
    };

    readonly insert = (batches: readonly SessionEventCacheV2Batch[]): boolean => {
        if (!this.#isAvailable) {
            return false;
        }
        const values = batches.flatMap((batch) =>
            batch.events.map((event, index) => ({
                eventJson: JSON.stringify(event),
                generationId: batch.sessionGenerationId,
                ordinal: batch.firstOrdinal + index,
                sessionId: batch.sessionId,
            })),
        );
        if (values.length === 0) {
            return true;
        }
        try {
            this.#localDatabase.transaction(() => {
                for (let offset = 0; offset < values.length; offset += 200) {
                    this.#database
                        .insert(sessionEventV2)
                        .values(values.slice(offset, offset + 200))
                        .run();
                }
            });
            for (const batch of batches) {
                const ordinals = this.#databaseOrdinalsBySession.get(batch.sessionId) ?? new Map<string, number>();
                for (const [index, event] of batch.events.entries()) {
                    ordinals.set(event.eventId, batch.firstOrdinal + index);
                }
                this.#databaseOrdinalsBySession.set(batch.sessionId, ordinals);
            }
            return true;
        } catch (cause) {
            this.#disableWrites(cause);
            return false;
        }
    };

    readonly read = (
        sessionId: string,
        sessionGenerationId: string,
        startOrdinal: number,
        endOrdinal: number,
    ): readonly { readonly event: SessionEventV2; readonly ordinal: number }[] => {
        if (this.#ignoredPersistedSessions.has(sessionId)) {
            return [];
        }
        return this.#database
            .select({ eventJson: sessionEventV2.eventJson, ordinal: sessionEventV2.ordinal })
            .from(sessionEventV2)
            .where(
                and(
                    eq(sessionEventV2.generationId, sessionGenerationId),
                    eq(sessionEventV2.sessionId, sessionId),
                    gte(sessionEventV2.ordinal, startOrdinal),
                    lte(sessionEventV2.ordinal, endOrdinal),
                ),
            )
            .orderBy(asc(sessionEventV2.ordinal))
            .all()
            .map((value) => {
                const row = cachedEventRowSchema.parse(value);
                return { event: decodeSessionEventV2(JSON.parse(row.eventJson)), ordinal: row.ordinal };
            });
    };

    readonly delete = (sessionId: string, sessionGenerationId?: string): void => {
        this.#databaseOrdinalsBySession.delete(sessionId);
        if (!this.#isAvailable) {
            this.#ignoredPersistedSessions.add(sessionId);
            return;
        }
        try {
            this.#database
                .delete(sessionEventV2)
                .where(
                    sessionGenerationId === undefined
                        ? eq(sessionEventV2.sessionId, sessionId)
                        : and(
                              eq(sessionEventV2.generationId, sessionGenerationId),
                              eq(sessionEventV2.sessionId, sessionId),
                          ),
                )
                .run();
            this.#ignoredPersistedSessions.delete(sessionId);
        } catch (cause) {
            this.#isAvailable = false;
            this.#ignoredPersistedSessions.add(sessionId);
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly close = (): void => {
        this.#localDatabase.close();
        this.#databaseOrdinalsBySession.clear();
        this.#ignoredPersistedSessions.clear();
    };

    readonly #disableWrites = (cause: unknown): void => {
        this.#isAvailable = false;
        console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
    };
}
