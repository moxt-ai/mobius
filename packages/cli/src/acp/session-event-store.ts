import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionEventPayload, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { SessionEventCacheDatabase } from "./session-event-cache-database.ts";
import { type MaterializedEventsResolver, SessionEventHistoryProjection } from "./session-event-history-projection.ts";
import { InMemorySessionEventIdAllocator, type SessionEventIdAllocator } from "./session-event-id-allocator.ts";
import type { SessionLiveEventPosition } from "./session-live-event-position.ts";
import type { ProjectedToolCall } from "./tool-call-projection.ts";

const HOT_EVENT_HIGH_WATER_MARK = 256;
const HOT_EVENT_RETENTION = 128;

class ProjectedSessionEvent {
    #event: SessionEvent;

    constructor(event: SessionEvent) {
        this.#event = event;
    }

    get event(): SessionEvent {
        return this.#event;
    }

    readonly replaceEvent = (event: SessionEvent): void => {
        this.#event = event;
    };
}

/**
 * Projected history for one Session generation.
 *
 * The projected order lives entirely in the {@link SessionEvents.#eventIds}
 * metadata array; event payloads are only materialized while they sit inside
 * the retention window or have been adopted back for a merge. Dropped payloads
 * are served from the cache database and written back after merges.
 */
class SessionEvents {
    readonly #eventIds: string[] = [];
    readonly #eventIndexById = new Map<string, number>();
    readonly #cachedItemsByEventId = new Map<string, ProjectedSessionEvent>();
    readonly #projection: SessionEventHistoryProjection;
    readonly sessionGenerationId: string;

    constructor(sessionGenerationId: string) {
        this.sessionGenerationId = sessionGenerationId;
        this.#projection = new SessionEventHistoryProjection();
    }

    readonly apply = (event: SessionLiveEvent, resolve: MaterializedEventsResolver): void => {
        const projected = this.#projection.apply(event, resolve);
        if (projected.kind === "replace") {
            const current = this.#cachedItemsByEventId.get(projected.replacedEventId);
            if (current === undefined) {
                throw new Error("The projected Session event is unavailable");
            }
            current.replaceEvent(projected.event);
            return;
        }
        const item = new ProjectedSessionEvent(projected.event);
        this.#eventIndexById.set(projected.event.eventId, this.#eventIds.length);
        this.#cachedItemsByEventId.set(projected.event.eventId, item);
        this.#eventIds.push(projected.event.eventId);
    };

    get materializedCount(): number {
        return this.#cachedItemsByEventId.size;
    }

    /** The projected tool call for this identifier, materializing it if needed. */
    readonly toolCall = (toolCallId: string, resolve: MaterializedEventsResolver): ProjectedToolCall | undefined =>
        this.#projection.getToolCall(toolCallId, resolve);

    readonly endIndex = (cursor: string | null): number => {
        if (cursor === null) {
            return this.#eventIds.length;
        }
        const index = this.#eventIndexById.get(cursor);
        if (index === undefined) {
            throw new Error("The native event cursor is invalid");
        }
        return index;
    };

    readonly cursorAt = (index: number): string => {
        const cursor = this.#eventIds[index];
        if (cursor === undefined) {
            throw new Error("The native event cursor is unavailable");
        }
        return cursor;
    };

    readonly item = (eventId: string): SessionEvent | undefined => this.#cachedItemsByEventId.get(eventId)?.event;

    /**
     * Materializes an event that was previously dropped to the cache database.
     * Its payload stays materialized until the next flush persists the merged
     * form and drops it again.
     */
    readonly adopt = (event: SessionEvent): boolean => {
        if (!this.#eventIndexById.has(event.eventId) || this.#cachedItemsByEventId.has(event.eventId)) {
            return false;
        }
        this.#cachedItemsByEventId.set(event.eventId, new ProjectedSessionEvent(event));
        return true;
    };

    /**
     * Fills the ordinal-keyed merge view with materialized events, overriding
     * stale persisted rows for the same ordinals.
     */
    readonly eventsInRange = (startIndex: number, endIndex: number, into: Map<number, SessionEvent>): void => {
        for (let index = startIndex; index < endIndex; index += 1) {
            const eventId = this.#eventIds[index];
            if (eventId === undefined) {
                throw new Error("The projected Session event is unavailable");
            }
            const item = this.#cachedItemsByEventId.get(eventId);
            if (item !== undefined) {
                into.set(index + 1, item.event);
            }
        }
    };

    /**
     * Collects the materialized events that fall outside the retention window,
     * including adopted merge targets behind it, so a successful flush can
     * persist them before they are dropped.
     */
    readonly pendingDrops = (
        includeHotTail: boolean,
    ): readonly { readonly event: SessionEvent; readonly ordinal: number }[] => {
        const windowStart = includeHotTail
            ? this.#eventIds.length
            : Math.max(0, this.#eventIds.length - HOT_EVENT_RETENTION);
        const drops: { readonly event: SessionEvent; readonly ordinal: number }[] = [];
        for (const [eventId, item] of this.#cachedItemsByEventId) {
            const index = this.#eventIndexById.get(eventId);
            if (index !== undefined && index < windowStart) {
                drops.push({ event: item.event, ordinal: index + 1 });
            }
        }
        return drops;
    };

    readonly commitDrops = (drops: readonly { readonly event: SessionEvent }[]): void => {
        for (const { event } of drops) {
            this.#cachedItemsByEventId.delete(event.eventId);
        }
    };
}

type FlushSchedule =
    | { readonly kind: "closed" }
    | { readonly kind: "idle" }
    | { readonly handle: NodeJS.Immediate; readonly kind: "scheduled" };

export interface AcpSessionEventPage {
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly truncated: boolean;
}

export interface AcpSessionEventStore {
    readonly append: (sessionId: string, event: SessionEventPayload) => SessionLiveEvent;
    readonly close: () => void;
    /**
     * The projected tool call announced with this identifier in its current
     * merged form, or `undefined` when no such announcement is recorded.
     */
    readonly getToolCall: (sessionId: string, toolCallId: string) => ProjectedToolCall | undefined;
    /**
     * Number of projected events whose payloads are currently held in memory.
     * The store keeps this bounded by its retention window; it is the
     * observable memory footprint of the Session event tier.
     */
    readonly materializedEventCount: (sessionId: string) => number;
    readonly materialize: (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ) => void;
    readonly page: (sessionId: string, eventLimit: number, cursor: string | null) => AcpSessionEventPage;
    readonly remove: (sessionId: string) => void;
    readonly reset: (sessionId: string) => void;
}

function liveEvent(
    sessionId: string,
    sessionGenerationId: string,
    eventId: string,
    position: number,
    event: SessionEventPayload,
): SessionLiveEvent {
    return {
        eventId,
        ...event,
        position: position.toString(),
        recordedAt: new Date().toISOString(),
        sessionGenerationId,
        sessionId,
    };
}

function eventPage(
    session: SessionEvents,
    sessionGenerationId: string,
    endIndex: number,
    eventLimit: number,
    read: (startIndex: number, endIndex: number) => readonly SessionEvent[],
): AcpSessionEventPage {
    const startIndex = Math.max(0, endIndex - eventLimit);
    return {
        events: read(startIndex, endIndex),
        nextCursor: startIndex === 0 ? null : session.cursorAt(startIndex),
        sessionGenerationId,
        truncated: startIndex > 0,
    };
}

export class MemoryAcpSessionEventStore implements AcpSessionEventStore {
    readonly #allocatedPositionBySession = new Map<string, number>();
    readonly #events = new Map<string, SessionEvents>();
    readonly #eventIds: SessionEventIdAllocator;

    constructor(eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator()) {
        this.#eventIds = eventIds;
    }

    readonly #session = (sessionId: string): SessionEvents => {
        const sessionGenerationId = randomUUID();
        const session = this.#events.get(sessionId) ?? new SessionEvents(sessionGenerationId);
        this.#events.set(sessionId, session);
        return session;
    };

    readonly #resolver =
        (session: SessionEvents): MaterializedEventsResolver =>
        (eventIds) => {
            const resolved = new Map<string, SessionEvent>();
            for (const eventId of eventIds) {
                const current = session.item(eventId);
                if (current !== undefined) {
                    resolved.set(eventId, current);
                }
            }
            return resolved;
        };

    readonly append = (sessionId: string, event: SessionEventPayload): SessionLiveEvent => {
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
        session.apply(recorded, this.#resolver(session));
        return recorded;
    };

    readonly close = (): void => {
        this.#allocatedPositionBySession.clear();
        this.#events.clear();
    };

    readonly getToolCall = (sessionId: string, toolCallId: string): ProjectedToolCall | undefined => {
        const session = this.#events.get(sessionId);
        return session === undefined ? undefined : session.toolCall(toolCallId, this.#resolver(session));
    };

    readonly materializedEventCount = (sessionId: string): number =>
        this.#events.get(sessionId)?.materializedCount ?? 0;

    readonly materialize = (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ): void => {
        if (this.#events.get(sessionId)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#events.set(sessionId, new SessionEvents(sessionGenerationId));
        for (const event of events) {
            this.append(sessionId, event);
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPage => {
        const session = this.#session(sessionId);
        const endIndex = session.endIndex(cursor);
        return eventPage(session, session.sessionGenerationId, endIndex, eventLimit, (start, end) => {
            const merged = new Map<number, SessionEvent>();
            session.eventsInRange(start, end, merged);
            return [...merged.entries()].toSorted((left, right) => left[0] - right[0]).map(([, event]) => event);
        });
    };

    readonly remove = (sessionId: string): void => {
        this.#events.delete(sessionId);
    };

    readonly reset = (sessionId: string): void => {
        const sessionGenerationId = randomUUID();
        this.#events.set(sessionId, new SessionEvents(sessionGenerationId));
    };
}

export class CachedAcpSessionEventStore implements AcpSessionEventStore {
    readonly #cacheDatabase: SessionEventCacheDatabase;
    readonly #eventIds: SessionEventIdAllocator;
    readonly #liveEventPositions: SessionLiveEventPosition;
    readonly #sessions = new Map<string, SessionEvents>();
    #flushSchedule: FlushSchedule = { kind: "idle" };

    constructor(
        localDatabase: LocalSqliteDatabase,
        liveEventPositions: SessionLiveEventPosition,
        eventIds: SessionEventIdAllocator = new InMemorySessionEventIdAllocator(),
    ) {
        this.#eventIds = eventIds;
        this.#liveEventPositions = liveEventPositions;
        this.#cacheDatabase = new SessionEventCacheDatabase(localDatabase);
    }

    readonly #session = (sessionId: string): SessionEvents => {
        const sessionGenerationId = randomUUID();
        const session = this.#sessions.get(sessionId) ?? new SessionEvents(sessionGenerationId);
        this.#sessions.set(sessionId, session);
        return session;
    };

    readonly #resolver =
        (sessionId: string, session: SessionEvents): MaterializedEventsResolver =>
        (eventIds) => {
            const resolved = new Map<string, SessionEvent>();
            const missing: string[] = [];
            for (const eventId of eventIds) {
                const current = session.item(eventId);
                if (current !== undefined) {
                    resolved.set(eventId, current);
                } else {
                    missing.push(eventId);
                }
            }
            for (const [eventId, stored] of this.#cacheDatabase.readByEventIds(
                sessionId,
                session.sessionGenerationId,
                missing,
            )) {
                if (session.adopt(stored)) {
                    resolved.set(eventId, stored);
                }
            }
            return resolved;
        };

    readonly append = (sessionId: string, event: SessionEventPayload): SessionLiveEvent => {
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
        session.apply(recorded, this.#resolver(sessionId, session));
        this.#sessions.set(sessionId, session);
        if (session.materializedCount > HOT_EVENT_HIGH_WATER_MARK) {
            this.#scheduleFlush();
        }
        return recorded;
    };

    readonly getToolCall = (sessionId: string, toolCallId: string): ProjectedToolCall | undefined => {
        const session = this.#sessions.get(sessionId);
        return session === undefined ? undefined : session.toolCall(toolCallId, this.#resolver(sessionId, session));
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
        events: readonly SessionEventPayload[],
    ): void => {
        if (this.#sessions.get(sessionId)?.sessionGenerationId === sessionGenerationId) {
            return;
        }
        this.#deletePersisted(sessionId);
        this.#sessions.set(sessionId, new SessionEvents(sessionGenerationId));
        for (const event of events) {
            this.append(sessionId, event);
        }
    };

    readonly #flush = (includeHotTail: boolean): void => {
        if (!this.#cacheDatabase.isAvailable || this.#flushSchedule.kind === "closed") {
            return;
        }
        const batches = [...this.#sessions.entries()].flatMap(([sessionId, session]) => {
            const drops = session.pendingDrops(includeHotTail);
            return drops.length === 0
                ? []
                : [
                      {
                          events: drops,
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
                this.#sessions.get(batch.sessionId)?.commitDrops(batch.events);
            }
        }
    };

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPage => {
        const session = this.#sessions.get(sessionId);
        const current = session ?? this.#session(sessionId);
        const endIndex = current.endIndex(cursor);
        return eventPage(current, current.sessionGenerationId, endIndex, eventLimit, (startIndex, endIndex) => {
            const merged = new Map<number, SessionEvent>();
            for (const { event, ordinal } of this.#cacheDatabase.read(
                sessionId,
                current.sessionGenerationId,
                startIndex + 1,
                endIndex,
            )) {
                merged.set(ordinal, event);
            }
            current.eventsInRange(startIndex, endIndex, merged);
            return [...merged.entries()].toSorted((left, right) => left[0] - right[0]).map(([, event]) => event);
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
        this.#sessions.set(sessionId, new SessionEvents(sessionGenerationId));
    };

    readonly materializedEventCount = (sessionId: string): number =>
        this.#sessions.get(sessionId)?.materializedCount ?? 0;

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
