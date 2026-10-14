import { randomUUID } from "node:crypto";
import type { SessionEventPayloadV2, SessionEventV2, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { SessionEventHistoryProjectionV2 } from "../session-event-history-projection-v2.ts";
import {
    InMemorySessionEventIdAllocator,
    type SessionEventIdAllocator,
} from "../session-event-id/session-event-id-allocator.ts";
import type { SessionLiveEventPosition } from "../session-live-event-position.ts";
import { SessionEventCacheV2Database } from "./session-event-cache-v2-database.ts";

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
    readonly #eventIndexById = new Map<string, number>();
    readonly #itemsByEventId = new Map<string, ProjectedSessionEventV2>();
    readonly #projectedEventIds: string[] = [];
    readonly #projection: SessionEventHistoryProjectionV2;
    readonly sessionGenerationId: string;

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
        this.#eventIndexById.set(projected.event.eventId, this.#projectedEventIds.length);
        this.#itemsByEventId.set(projected.event.eventId, item);
        this.#projectedEventIds.push(projected.event.eventId);
        return { item, kind: "append" };
    };

    get projectedEventCount(): number {
        return this.#projectedEventIds.length;
    }

    readonly endIndex = (cursor: string | null): number => {
        if (cursor === null) {
            return this.projectedEventCount;
        }
        const index = this.#eventIndexById.get(cursor);
        if (index === undefined) {
            throw new Error("The native event cursor is invalid");
        }
        return index;
    };

    readonly cursorAt = (index: number): string => {
        const cursor = this.#projectedEventIds[index];
        if (cursor === undefined) {
            throw new Error("The native event cursor is unavailable");
        }
        return cursor;
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
    session: SessionEventsV2,
    sessionGenerationId: string,
    endIndex: number,
    eventLimit: number,
    read: (startIndex: number, endIndex: number) => readonly SessionEventV2[],
): AcpSessionEventPageV2 {
    const startIndex = Math.max(0, endIndex - eventLimit);
    return {
        events: read(startIndex, endIndex),
        nextCursor: startIndex === 0 ? null : session.cursorAt(startIndex),
        sessionGenerationId,
        truncated: startIndex > 0,
    };
}

export class MemoryAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #allocatedPositionBySession = new Map<string, number>();
    readonly #events = new Map<string, SessionEventsV2>();
    readonly #eventIds: SessionEventIdAllocator;

    constructor(eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator()) {
        this.#eventIds = eventIds;
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
        const allocatedPosition = this.#allocatedPositionBySession.get(sessionId) ?? 9_999;
        if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
            throw new Error("The live Session event position allocation is exhausted");
        }
        const position = allocatedPosition + 1;
        this.#allocatedPositionBySession.set(sessionId, position);
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
        this.#allocatedPositionBySession.clear();
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
        const endIndex = session.endIndex(cursor);
        return eventPage(session, session.sessionGenerationId, endIndex, eventLimit, (start, end) =>
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

export class CachedAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #cacheDatabase: SessionEventCacheV2Database;
    readonly #eventIds: SessionEventIdAllocator;
    readonly #liveEventPositions: SessionLiveEventPosition;
    readonly #sessions = new Map<string, SessionEventsV2>();
    #flushSchedule: FlushSchedule = { kind: "idle" };

    constructor(
        localDatabase: LocalSqliteDatabase,
        liveEventPositions: SessionLiveEventPosition,
        eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator(),
    ) {
        this.#eventIds = eventIds;
        this.#liveEventPositions = liveEventPositions;
        this.#cacheDatabase = new SessionEventCacheV2Database(localDatabase);
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
        this.#cacheDatabase.replace(sessionId, session.sessionGenerationId, item.event);
    };

    readonly #scheduleFlush = (): void => {
        if (!this.#cacheDatabase.isAvailable || this.#flushSchedule.kind !== "idle") {
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
        this.#sessions.set(
            sessionId,
            new SessionEventsV2(sessionGenerationId, () => this.#eventIds.allocate(sessionId, sessionGenerationId)),
        );
        for (const event of events) {
            this.append(sessionId, event);
        }
    };

    readonly #flush = (includeHotTail: boolean): void => {
        if (!this.#cacheDatabase.isAvailable || this.#flushSchedule.kind === "closed") {
            return;
        }
        const batches = [...this.#sessions.entries()].flatMap(([sessionId, session]) => {
            const count = includeHotTail ? session.hot.length : Math.max(0, session.hot.length - HOT_EVENT_RETENTION);
            return count === 0
                ? []
                : [
                      {
                          count,
                          events: session.hot.slice(0, count).map(({ event }) => event),
                          firstOrdinal: session.projectedEventCount - session.hot.length + 1,
                          sessionGenerationId: session.sessionGenerationId,
                          sessionId,
                      },
                  ];
        });
        if (batches.length === 0) {
            return;
        }
        if (this.#cacheDatabase.insert(batches)) {
            for (const batch of batches) {
                const session = this.#sessions.get(batch.sessionId);
                if (session !== undefined) {
                    session.removeHotHead(batch.count);
                }
            }
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const session = this.#sessions.get(sessionId);
        const current = session ?? this.#session(sessionId);
        const endIndex = current.endIndex(cursor);
        return eventPage(current, current.sessionGenerationId, endIndex, eventLimit, (startIndex, endIndex) => {
            const startOrdinal = startIndex + 1;
            const endOrdinal = endIndex;
            const persisted = this.#cacheDatabase.read(
                sessionId,
                current.sessionGenerationId,
                startOrdinal,
                endOrdinal,
            );
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
        this.#cacheDatabase.delete(sessionId, sessionGenerationId);
    };

    readonly remove = (sessionId: string): void => {
        this.#deletePersisted(sessionId);
        this.#sessions.delete(sessionId);
    };

    readonly reset = (sessionId: string): void => {
        const previous = this.#sessions.get(sessionId);
        this.#deletePersisted(sessionId, previous?.sessionGenerationId);
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
        this.#cacheDatabase.close();
        this.#sessions.clear();
    };
}
