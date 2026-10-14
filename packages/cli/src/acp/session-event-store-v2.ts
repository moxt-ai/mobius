import { randomUUID } from "node:crypto";
import {
    decodeSessionEventV2,
    type SessionEventPayloadV2,
    type SessionEventV2,
    type SessionLiveEventV2,
} from "@moxt-ai/mobius-protocol";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionEventV2 } from "../schema/session-event-cache/index.ts";
import { SessionEventHistoryProjectionV2 } from "../session-event-history-projection-v2.ts";
import {
    InMemorySessionEventIdAllocator,
    type SessionEventIdAllocator,
} from "../session-event-id/session-event-id-allocator.ts";
import { MemorySessionLiveEventPosition, type SessionLiveEventPosition } from "../session-live-event-position.ts";

const HOT_EVENT_HIGH_WATER_MARK = 256;
const HOT_EVENT_RETENTION = 128;

class ProjectedSessionEventV2 {
    #event: SessionEventV2;

    constructor(event: SessionEventV2) {
        this.#event = event;
    }

    get event(): SessionEventV2 {
        return this.#event;
    }

    readonly replaceEvent = (event: SessionEventV2): void => {
        this.#event = event;
    };
}

class SessionEventsV2 {
    readonly hot: ProjectedSessionEventV2[] = [];
    readonly #itemsByEventId = new Map<string, ProjectedSessionEventV2>();
    readonly #projection: SessionEventHistoryProjectionV2;
    readonly sessionGenerationId: string;
    projectedEventCount = 0;

    constructor(sessionGenerationId: string, allocateEventId: () => string) {
        this.sessionGenerationId = sessionGenerationId;
        this.#projection = new SessionEventHistoryProjectionV2(allocateEventId);
    }

    readonly apply = (
        event: SessionLiveEventV2,
    ): { readonly item: ProjectedSessionEventV2; readonly kind: "append" | "replace" } => {
        const projected = this.#projection.apply(event);
        if (projected.kind === "replace") {
            const current = this.#itemsByEventId.get(projected.replacedEventId);
            if (current === undefined) {
                throw new Error("The projected Session event is unavailable");
            }
            current.replaceEvent(projected.event);
            return { item: current, kind: "replace" };
        }
        const item = new ProjectedSessionEventV2(projected.event);
        this.hot.push(item);
        this.#itemsByEventId.set(projected.event.eventId, item);
        this.projectedEventCount += 1;
        return { item, kind: "append" };
    };

    readonly removeHotHead = (count: number): void => {
        const removed = this.hot.splice(0, count);
        for (const item of removed) {
            if (!this.#projection.canReplace(item.event.eventId)) {
                this.#itemsByEventId.delete(item.event.eventId);
            }
        }
    };
}

type FlushSchedule =
    | { readonly kind: "closed" }
    | { readonly kind: "idle" }
    | { readonly handle: NodeJS.Immediate; readonly kind: "scheduled" };

export interface AcpSessionEventPageV2 {
    readonly events: readonly SessionEventV2[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly truncated: boolean;
}

export interface AcpSessionEventStoreV2 {
    readonly append: (sessionId: string, event: SessionEventPayloadV2) => SessionLiveEventV2;
    readonly close: () => void;
    readonly materialize: (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayloadV2[],
    ) => void;
    readonly page: (sessionId: string, eventLimit: number, cursor: string | null) => AcpSessionEventPageV2;
    readonly remove: (sessionId: string) => void;
    readonly reset: (sessionId: string) => void;
}

function liveEvent(
    sessionId: string,
    sessionGenerationId: string,
    eventId: string,
    position: number,
    event: SessionEventPayloadV2,
): SessionLiveEventV2 {
    return {
        eventId,
        ...event,
        provenance: { kind: "original" },
        position: position.toString(),
        recordedAt: new Date().toISOString(),
        sessionGenerationId,
        sessionId,
    };
}

function eventPage(
    sessionGenerationId: string,
    endIndex: number,
    eventLimit: number,
    read: (startIndex: number, endIndex: number) => readonly SessionEventV2[],
): AcpSessionEventPageV2 {
    const startIndex = Math.max(0, endIndex - eventLimit);
    return {
        events: read(startIndex, endIndex),
        nextCursor: startIndex === 0 ? null : startIndex.toString(),
        sessionGenerationId,
        truncated: startIndex > 0,
    };
}

export class MemoryAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #events = new Map<string, SessionEventsV2>();
    readonly #eventIds: SessionEventIdAllocator;
    readonly #liveEventPositions: SessionLiveEventPosition;

    constructor(
        eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator(),
        liveEventPositions: SessionLiveEventPosition = new MemorySessionLiveEventPosition(),
    ) {
        this.#eventIds = eventIds;
        this.#liveEventPositions = liveEventPositions;
    }

    readonly #session = (sessionId: string): SessionEventsV2 => {
        const sessionGenerationId = randomUUID();
        const session =
            this.#events.get(sessionId) ??
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId));
        this.#events.set(sessionId, session);
        return session;
    };

    readonly append = (sessionId: string, event: SessionEventPayloadV2): SessionLiveEventV2 => {
        const session = this.#session(sessionId);
        const position = this.#liveEventPositions.allocate(sessionId);
        const recorded = liveEvent(
            sessionId,
            session.sessionGenerationId,
            this.#eventIds.allocate(sessionId, session.sessionGenerationId),
            position,
            event,
        );
        session.apply(recorded);
        return recorded;
    };

    readonly close = (): void => {
        this.#events.clear();
    };

    readonly materialize = (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayloadV2[],
    ): void => {
        if (this.#events.get(sessionId)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#events.set(
            sessionId,
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId)),
        );
        for (const event of events) {
            this.append(sessionId, event);
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const session = this.#session(sessionId);
        const endIndex = cursor === null ? session.projectedEventCount : Number(cursor);
        if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > session.projectedEventCount) {
            throw new Error("The native event cursor is invalid");
        }
        return eventPage(session.sessionGenerationId, endIndex, eventLimit, (start, end) =>
            session.hot.slice(start, end).map(({ event }) => event),
        );
    };

    readonly remove = (sessionId: string): void => {
        this.#events.delete(sessionId);
    };

    readonly reset = (sessionId: string): void => {
        const sessionGenerationId = randomUUID();
        this.#events.set(
            sessionId,
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId)),
        );
    };
}

const cachedEventRowSchema = z.object({ eventJson: z.string(), ordinal: z.number().int().positive() });
function decodeCachedEvent(value: unknown): SessionEventV2 {
    return decodeSessionEventV2(value);
}

export class CachedAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #database: NodeSQLiteDatabase;
    readonly #eventIds: SessionEventIdAllocator;
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #liveEventPositions: SessionLiveEventPosition;
    readonly #localDatabase: LocalSqliteDatabase;
    readonly #databaseOrdinalsBySession = new Map<string, Map<string, number>>();
    readonly #sessions = new Map<string, SessionEventsV2>();
    #flushSchedule: FlushSchedule = { kind: "idle" };
    #isLocalDBAvailable = true;

    constructor(
        localDatabase: LocalSqliteDatabase,
        liveEventPositions: SessionLiveEventPosition = new MemorySessionLiveEventPosition(),
        eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator(),
    ) {
        this.#localDatabase = localDatabase;
        this.#eventIds = eventIds;
        this.#liveEventPositions = liveEventPositions;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEventV2).run());
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    readonly #session = (sessionId: string): SessionEventsV2 => {
        const sessionGenerationId = randomUUID();
        const session =
            this.#sessions.get(sessionId) ??
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId));
        this.#sessions.set(sessionId, session);
        return session;
    };

    readonly append = (sessionId: string, event: SessionEventPayloadV2): SessionLiveEventV2 => {
        if (this.#flushSchedule.kind === "closed") {
            throw new Error("The V2 Session event store is closed");
        }
        const session = this.#session(sessionId);
        const position = this.#liveEventPositions.allocate(sessionId);
        const recorded = liveEvent(
            sessionId,
            session.sessionGenerationId,
            this.#eventIds.allocate(sessionId, session.sessionGenerationId),
            position,
            event,
        );
        const projected = session.apply(recorded);
        if (projected.kind === "replace") {
            this.#updateProjectedEvent(sessionId, session, projected.item);
        }
        this.#sessions.set(sessionId, session);
        if (session.hot.length > HOT_EVENT_HIGH_WATER_MARK) {
            this.#scheduleFlush();
        }
        return recorded;
    };

    readonly #updateProjectedEvent = (
        sessionId: string,
        session: SessionEventsV2,
        item: ProjectedSessionEventV2,
    ): void => {
        if (!this.#isLocalDBAvailable) {
            return;
        }
        const ordinal = this.#databaseOrdinalsBySession.get(sessionId)?.get(item.event.eventId);
        if (ordinal === undefined) {
            return;
        }
        try {
            this.#database
                .update(sessionEventV2)
                .set({ eventJson: JSON.stringify(item.event) })
                .where(
                    and(
                        eq(sessionEventV2.generationId, session.sessionGenerationId),
                        eq(sessionEventV2.sessionId, sessionId),
                        eq(sessionEventV2.ordinal, ordinal),
                    ),
                )
                .run();
        } catch (cause) {
            this.#isLocalDBAvailable = false;
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
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

    readonly materialize = (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayloadV2[],
    ): void => {
        if (this.#sessions.get(sessionId)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#deletePersisted(sessionId);
        this.#databaseOrdinalsBySession.delete(sessionId);
        this.#sessions.set(
            sessionId,
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId)),
        );
        for (const event of events) {
            this.append(sessionId, event);
        }
    };

    readonly #flush = (includeHotTail: boolean): void => {
        if (!this.#isLocalDBAvailable || this.#flushSchedule.kind === "closed") {
            return;
        }
        const batches = [...this.#sessions.entries()].flatMap(([sessionId, session]) => {
            const count = includeHotTail ? session.hot.length : Math.max(0, session.hot.length - HOT_EVENT_RETENTION);
            return count === 0
                ? []
                : [
                      {
                          count,
                          events: session.hot.slice(0, count),
                          firstOrdinal: session.projectedEventCount - session.hot.length + 1,
                          sessionGenerationId: session.sessionGenerationId,
                          sessionId,
                      },
                  ];
        });
        const values = batches.flatMap((batch) =>
            batch.events.map(({ event }, index) => ({
                eventJson: JSON.stringify(event),
                generationId: batch.sessionGenerationId,
                ordinal: batch.firstOrdinal + index,
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
                const ordinals = this.#databaseOrdinalsBySession.get(batch.sessionId) ?? new Map<string, number>();
                for (const [index, item] of batch.events.entries()) {
                    ordinals.set(item.event.eventId, batch.firstOrdinal + index);
                }
                this.#databaseOrdinalsBySession.set(batch.sessionId, ordinals);
                const session = this.#sessions.get(batch.sessionId);
                if (session !== undefined) {
                    session.removeHotHead(batch.count);
                }
            }
        } catch (cause) {
            this.#isLocalDBAvailable = false;
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const session = this.#sessions.get(sessionId);
        const current = session ?? this.#session(sessionId);
        const endIndex = cursor === null ? current.projectedEventCount : Number(cursor);
        if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > current.projectedEventCount) {
            throw new Error("The native event cursor is invalid");
        }
        return eventPage(current.sessionGenerationId, endIndex, eventLimit, (startIndex, endIndex) => {
            const startOrdinal = startIndex + 1;
            const endOrdinal = endIndex;
            const persisted = this.#ignoredPersistedSessions.has(sessionId)
                ? []
                : this.#database
                      .select({ eventJson: sessionEventV2.eventJson, ordinal: sessionEventV2.ordinal })
                      .from(sessionEventV2)
                      .where(
                          and(
                              eq(sessionEventV2.generationId, current.sessionGenerationId),
                              eq(sessionEventV2.sessionId, sessionId),
                              gte(sessionEventV2.ordinal, startOrdinal),
                              lte(sessionEventV2.ordinal, endOrdinal),
                          ),
                      )
                      .orderBy(asc(sessionEventV2.ordinal))
                      .all()
                      .map((value): { readonly event: SessionEventV2; readonly ordinal: number } => {
                          const row = cachedEventRowSchema.parse(value);
                          const cached = decodeCachedEvent(JSON.parse(row.eventJson));
                          return { event: cached, ordinal: row.ordinal };
                      });
            const firstHotOrdinal = current.projectedEventCount - current.hot.length + 1;
            const hot = current.hot.flatMap((item, index) => {
                const ordinal = firstHotOrdinal + index;
                return ordinal >= startOrdinal && ordinal <= endOrdinal ? [{ event: item.event, ordinal }] : [];
            });
            return [...persisted, ...hot]
                .toSorted((left, right) => left.ordinal - right.ordinal)
                .map(({ event }) => event);
        });
    };

    readonly #deletePersisted = (sessionId: string, sessionGenerationId?: string): void => {
        if (!this.#isLocalDBAvailable) {
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
            this.#isLocalDBAvailable = false;
            this.#ignoredPersistedSessions.add(sessionId);
            console.warn("Mobius V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly remove = (sessionId: string): void => {
        this.#deletePersisted(sessionId);
        this.#sessions.delete(sessionId);
        this.#databaseOrdinalsBySession.delete(sessionId);
    };

    readonly reset = (sessionId: string): void => {
        const previous = this.#sessions.get(sessionId);
        this.#deletePersisted(sessionId, previous?.sessionGenerationId);
        this.#databaseOrdinalsBySession.delete(sessionId);
        const sessionGenerationId = randomUUID();
        this.#sessions.set(
            sessionId,
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId)),
        );
    };

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
        this.#databaseOrdinalsBySession.clear();
    };
}
