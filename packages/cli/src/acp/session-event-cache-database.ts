import { decodeSessionEvent, type SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import { sessionEvent } from "../schema/session-event-cache/index.ts";
import type { LocalSqliteDatabase } from "../storage/sqlite/local-sqlite-database.ts";

const cachedEventRowSchema = z.object({ eventJson: z.string() });
const cachedEventOrdinalRowSchema = z.object({ eventJson: z.string(), ordinal: z.number().int().positive() });

interface SessionEventCacheBatch {
    readonly events: readonly { readonly event: SessionEvent; readonly ordinal: number }[];
    readonly sessionGenerationId: string;
    readonly sessionId: string;
}

export class SessionEventCacheDatabase {
    readonly #database: NodeSQLiteDatabase;
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #localDatabase: LocalSqliteDatabase;
    #isAvailable = true;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEvent).run());
            // Reclaim the space left by the previous process so the cache file
            // tracks live rows instead of its historical high-water mark.
            this.#localDatabase.exec("VACUUM");
            this.#checkpoint();
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    get isAvailable(): boolean {
        return this.#isAvailable;
    }

    /**
     * Persists materialized events, overwriting rows that were read back into
     * memory and merged since they were last written.
     */
    readonly insert = (batches: readonly SessionEventCacheBatch[]): boolean => {
        if (!this.#isAvailable) {
            return false;
        }
        const values = batches.flatMap((batch) =>
            batch.events.map(({ event, ordinal }) => ({
                eventJson: JSON.stringify(event),
                eventId: event.eventId,
                generationId: batch.sessionGenerationId,
                ordinal,
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
                        .onConflictDoUpdate({
                            target: [sessionEvent.sessionId, sessionEvent.eventId],
                            set: { eventJson: sql`excluded.event_json` },
                        })
                        .run();
                }
            });
            return true;
        } catch (cause) {
            this.#disableWrites(cause);
            return false;
        }
    };

    /**
     * Reads persisted events back by identifier so merges can target events
     * whose payloads were dropped from memory. The rows stay in place; the
     * next flush overwrites them with the merged payloads.
     */
    readonly readByEventIds = (
        sessionId: string,
        sessionGenerationId: string,
        eventIds: readonly string[],
    ): ReadonlyMap<string, SessionEvent> => {
        if (eventIds.length === 0 || this.#ignoredPersistedSessions.has(sessionId)) {
            return new Map();
        }
        let rows: { readonly eventId: string; readonly eventJson: string }[];
        try {
            rows = this.#database
                .select({ eventId: sessionEvent.eventId, eventJson: sessionEvent.eventJson })
                .from(sessionEvent)
                .where(
                    and(
                        eq(sessionEvent.generationId, sessionGenerationId),
                        eq(sessionEvent.sessionId, sessionId),
                        inArray(sessionEvent.eventId, eventIds),
                    ),
                )
                .all();
        } catch (cause) {
            this.#disableWrites(cause);
            return new Map();
        }
        const resolved = new Map<string, SessionEvent>();
        for (const row of rows) {
            // A row that no longer decodes is reported as missing so a single
            // incompatible row degrades one merge instead of all persistence.
            try {
                resolved.set(row.eventId, decodeSessionEvent(JSON.parse(cachedEventRowSchema.parse(row).eventJson)));
            } catch {
                // Keep the undecodable row unresolved.
            }
        }
        return resolved;
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
                const row = cachedEventOrdinalRowSchema.parse(value);
                return { event: decodeSessionEvent(JSON.parse(row.eventJson)), ordinal: row.ordinal };
            });
    };

    readonly delete = (sessionId: string, sessionGenerationId?: string): void => {
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
        if (this.#isAvailable) {
            // Truncating the write-ahead log is best effort; closing the
            // database handle must happen even when it fails.
            try {
                this.#checkpoint();
            } catch (cause) {
                console.warn("Mobius V2 Session event cache checkpoint on close failed", cause);
            }
        }
        this.#localDatabase.close();
        this.#ignoredPersistedSessions.clear();
    };

    readonly #checkpoint = (): void => {
        this.#localDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    };

    readonly #disableWrites = (cause: unknown): void => {
        this.#isAvailable = false;
        console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
    };
}
