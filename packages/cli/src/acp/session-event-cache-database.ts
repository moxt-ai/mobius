import { decodeSessionEvent, type SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionEvent } from "../schema/session-event-cache/index.ts";

const cachedEventRowSchema = z.object({ eventJson: z.string(), ordinal: z.number().int().positive() });

interface SessionEventCacheBatch {
    readonly events: readonly SessionEvent[];
    readonly firstOrdinal: number;
    readonly sessionGenerationId: string;
    readonly sessionId: string;
}

export class SessionEventCacheDatabase {
    readonly #database: NodeSQLiteDatabase;
    readonly #databaseOrdinalsBySession = new Map<string, Map<string, number>>();
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #localDatabase: LocalSqliteDatabase;
    #isAvailable = true;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEvent).run());
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    get isAvailable(): boolean {
        return this.#isAvailable;
    }

    readonly replace = (sessionId: string, sessionGenerationId: string, event: SessionEvent): void => {
        if (!this.#isAvailable) {
            return;
        }
        const ordinal = this.#databaseOrdinalsBySession.get(sessionId)?.get(event.eventId);
        if (ordinal === undefined) {
            return;
        }
        try {
            this.#database
                .update(sessionEvent)
                .set({ eventJson: JSON.stringify(event) })
                .where(
                    and(
                        eq(sessionEvent.generationId, sessionGenerationId),
                        eq(sessionEvent.sessionId, sessionId),
                        eq(sessionEvent.ordinal, ordinal),
                    ),
                )
                .run();
        } catch (cause) {
            this.#disableWrites(cause);
        }
    };

    readonly insert = (batches: readonly SessionEventCacheBatch[]): boolean => {
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
                        .insert(sessionEvent)
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
    ): readonly { readonly event: SessionEvent; readonly ordinal: number }[] => {
        if (this.#ignoredPersistedSessions.has(sessionId)) {
            return [];
        }
        return this.#database
            .select({ eventJson: sessionEvent.eventJson, ordinal: sessionEvent.ordinal })
            .from(sessionEvent)
            .where(
                and(
                    eq(sessionEvent.generationId, sessionGenerationId),
                    eq(sessionEvent.sessionId, sessionId),
                    gte(sessionEvent.ordinal, startOrdinal),
                    lte(sessionEvent.ordinal, endOrdinal),
                ),
            )
            .orderBy(asc(sessionEvent.ordinal))
            .all()
            .map((value) => {
                const row = cachedEventRowSchema.parse(value);
                return { event: decodeSessionEvent(JSON.parse(row.eventJson)), ordinal: row.ordinal };
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
                .delete(sessionEvent)
                .where(
                    sessionGenerationId === undefined
                        ? eq(sessionEvent.sessionId, sessionId)
                        : and(
                              eq(sessionEvent.generationId, sessionGenerationId),
                              eq(sessionEvent.sessionId, sessionId),
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
