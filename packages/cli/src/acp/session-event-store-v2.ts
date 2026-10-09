import { decodeSessionEventV2, type SessionEventPayloadV2 } from "@moxt-ai/mobius-protocol";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionEventV2 } from "../schema/session-event-cache/index.ts";

const HOT_EVENT_HIGH_WATER_MARK = 256;
const HOT_EVENT_RETENTION = 128;

interface PositionedSessionEventV2 {
    readonly event: SessionEventPayloadV2;
    readonly position: number;
}

interface SessionEventsV2 {
    readonly hot: PositionedSessionEventV2[];
    nextPosition: number;
}

type FlushSchedule =
    | { readonly kind: "closed" }
    | { readonly kind: "idle" }
    | { readonly handle: NodeJS.Immediate; readonly kind: "scheduled" };

export interface AcpSessionEventPageV2 {
    readonly events: readonly SessionEventPayloadV2[];
    readonly nextCursor: string | null;
    readonly startPosition: number;
    readonly truncated: boolean;
}

export interface AcpSessionEventStoreV2 {
    readonly append: (sessionId: string, event: SessionEventPayloadV2) => number;
    readonly close: () => void;
    readonly generationId: string;
    readonly page: (sessionId: string, eventLimit: number, cursor: string | null) => AcpSessionEventPageV2;
    readonly remove: (sessionId: string) => void;
    readonly reset: (sessionId: string) => void;
}

function eventPage(
    eventCount: number,
    eventLimit: number,
    cursor: string | null,
    read: (startPosition: number, endPosition: number) => readonly SessionEventPayloadV2[],
): AcpSessionEventPageV2 {
    const parsedCursor = cursor === null ? eventCount : Number(cursor);
    if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0 || parsedCursor > eventCount) {
        throw new Error("The native event cursor is invalid");
    }
    const endPosition = parsedCursor;
    const startPosition = Math.max(0, endPosition - eventLimit);
    return {
        events: read(startPosition + 1, endPosition),
        nextCursor: startPosition === 0 ? null : startPosition.toString(),
        startPosition: startPosition + 1,
        truncated: startPosition > 0,
    };
}

export class MemoryAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly generationId: string;
    readonly #events = new Map<string, SessionEventPayloadV2[]>();

    constructor(generationId: string) {
        this.generationId = generationId;
    }

    readonly append = (sessionId: string, event: SessionEventPayloadV2): number => {
        const events = this.#events.get(sessionId) ?? [];
        events.push(event);
        this.#events.set(sessionId, events);
        return events.length;
    };

    readonly close = (): void => this.#events.clear();

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const events = this.#events.get(sessionId) ?? [];
        return eventPage(events.length, eventLimit, cursor, (startPosition, endPosition) =>
            events.slice(startPosition - 1, endPosition),
        );
    };

    readonly remove = (sessionId: string): void => {
        this.#events.delete(sessionId);
    };

    readonly reset = this.remove;
}

const cachedEventRowSchema = z.object({ eventJson: z.string(), position: z.number().int().positive() });

function decodeCachedEvent(value: unknown): SessionEventPayloadV2 {
    const payload = z.record(z.string(), z.unknown()).parse(value);
    const event = decodeSessionEventV2({
        ...payload,
        eventId: "cached-event",
        position: "1",
        provenance: { kind: "original" },
        recordedAt: "1970-01-01T00:00:00.000Z",
        sessionId: "cached-session",
    });
    return event.type === "acp"
        ? { payload: event.payload, type: event.type }
        : { payload: event.payload, type: event.type };
}

export class CachedAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly generationId: string;
    readonly #database: NodeSQLiteDatabase;
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #localDatabase: LocalSqliteDatabase;
    readonly #sessions = new Map<string, SessionEventsV2>();
    #flushSchedule: FlushSchedule = { kind: "idle" };
    #isLocalDBAvailable = true;

    constructor(localDatabase: LocalSqliteDatabase, generationId: string) {
        this.generationId = generationId;
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEventV2).run());
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    readonly append = (sessionId: string, event: SessionEventPayloadV2): number => {
        if (this.#flushSchedule.kind === "closed") {
            throw new Error("The V2 Session event store is closed");
        }
        const session = this.#sessions.get(sessionId) ?? { hot: [], nextPosition: 1 };
        const position = session.nextPosition;
        session.hot.push({ event, position });
        session.nextPosition += 1;
        this.#sessions.set(sessionId, session);
        if (session.hot.length > HOT_EVENT_HIGH_WATER_MARK) {
            this.#scheduleFlush();
        }
        return position;
    };

    readonly #scheduleFlush = (): void => {
        if (!this.#isLocalDBAvailable || this.#flushSchedule.kind !== "idle") {
            return;
        }
        const handle = setImmediate(() => {
            if (this.#flushSchedule.kind !== "scheduled" || this.#flushSchedule.handle !== handle) {
                return;
            }
            this.#flushSchedule = { kind: "idle" };
            this.#flush(false);
        });
        this.#flushSchedule = { handle, kind: "scheduled" };
    };

    readonly #flush = (includeHotTail: boolean): void => {
        if (!this.#isLocalDBAvailable || this.#flushSchedule.kind === "closed") {
            return;
        }
        const batches = [...this.#sessions.entries()].flatMap(([sessionId, session]) => {
            const count = includeHotTail ? session.hot.length : Math.max(0, session.hot.length - HOT_EVENT_RETENTION);
            return count === 0 ? [] : [{ count, events: session.hot.slice(0, count), sessionId }];
        });
        const values = batches.flatMap((batch) =>
            batch.events.map(({ event, position }) => ({
                eventJson: JSON.stringify(event),
                generationId: this.generationId,
                position,
                sessionId: batch.sessionId,
            })),
        );
        if (values.length === 0) {
            return;
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
                this.#sessions.get(batch.sessionId)?.hot.splice(0, batch.count);
            }
        } catch (cause) {
            this.#isLocalDBAvailable = false;
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const session = this.#sessions.get(sessionId);
        const eventCount = (session?.nextPosition ?? 1) - 1;
        return eventPage(eventCount, eventLimit, cursor, (startPosition, endPosition) => {
            const persisted = this.#ignoredPersistedSessions.has(sessionId)
                ? []
                : this.#database
                      .select({ eventJson: sessionEventV2.eventJson, position: sessionEventV2.position })
                      .from(sessionEventV2)
                      .where(
                          and(
                              eq(sessionEventV2.generationId, this.generationId),
                              eq(sessionEventV2.sessionId, sessionId),
                              gte(sessionEventV2.position, startPosition),
                              lte(sessionEventV2.position, endPosition),
                          ),
                      )
                      .orderBy(asc(sessionEventV2.position))
                      .all()
                      .map((value): PositionedSessionEventV2 => {
                          const row = cachedEventRowSchema.parse(value);
                          return { event: decodeCachedEvent(JSON.parse(row.eventJson)), position: row.position };
                      });
            const hot = (session?.hot ?? []).filter(
                ({ position }) => position >= startPosition && position <= endPosition,
            );
            return [...persisted, ...hot]
                .toSorted((left, right) => left.position - right.position)
                .map(({ event }) => event);
        });
    };

    readonly #deletePersisted = (sessionId: string): void => {
        if (!this.#isLocalDBAvailable) {
            this.#ignoredPersistedSessions.add(sessionId);
            return;
        }
        try {
            this.#database
                .delete(sessionEventV2)
                .where(and(eq(sessionEventV2.generationId, this.generationId), eq(sessionEventV2.sessionId, sessionId)))
                .run();
            this.#ignoredPersistedSessions.delete(sessionId);
        } catch (cause) {
            this.#isLocalDBAvailable = false;
            this.#ignoredPersistedSessions.add(sessionId);
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly remove = (sessionId: string): void => {
        this.#deletePersisted(sessionId);
        this.#sessions.delete(sessionId);
    };

    readonly reset = this.remove;

    readonly close = (): void => {
        if (this.#flushSchedule.kind === "closed") {
            return;
        }
        if (this.#flushSchedule.kind === "scheduled") {
            clearImmediate(this.#flushSchedule.handle);
        }
        this.#flushSchedule = { kind: "idle" };
        this.#flush(true);
        this.#flushSchedule = { kind: "closed" };
        this.#localDatabase.close();
        this.#sessions.clear();
    };
}
