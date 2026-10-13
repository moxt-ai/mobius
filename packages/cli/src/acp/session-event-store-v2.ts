import { randomUUID } from "node:crypto";
import { type AcpSessionUpdateV2, decodeSessionEventV2, type SessionEventPayloadV2 } from "@moxt-ai/mobius-protocol";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionEventV2 } from "../schema/session-event-cache/index.ts";

const HOT_EVENT_HIGH_WATER_MARK = 256;
const HOT_EVENT_RETENTION = 128;

class PositionedSessionEventV2 {
    #event: SessionEventPayloadV2;
    readonly position: number;

    constructor(event: SessionEventPayloadV2, position: number) {
        this.#event = event;
        this.position = position;
    }

    get event(): SessionEventPayloadV2 {
        return this.#event;
    }

    readonly replaceEvent = (event: SessionEventPayloadV2): void => {
        this.#event = event;
    };
}

class SessionEventsV2 {
    readonly hot: PositionedSessionEventV2[] = [];
    readonly #toolCallUpdateMap = new Map<string, PositionedSessionEventV2>();
    readonly sessionGenerationId: string;
    nextPosition = 1;

    constructor() {
        this.sessionGenerationId = randomUUID();
    }

    readonly getToolCallUpdate = (toolCallId: string): PositionedSessionEventV2 | undefined =>
        this.#toolCallUpdateMap.get(toolCallId);

    readonly updateToolCallUpdate = (toolCallId: string, item: PositionedSessionEventV2): boolean => {
        const current = this.#toolCallUpdateMap.get(toolCallId);
        if (current === undefined || current.position !== item.position) {
            return false;
        }
        current.replaceEvent(item.event);
        return true;
    };

    readonly append = (item: PositionedSessionEventV2): void => {
        this.hot.push(item);
        const event = item.event;
        if (
            event.type === "acp" &&
            (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
        ) {
            this.#toolCallUpdateMap.set(event.payload.toolCallId, item);
        }
    };

    readonly removeHotHead = (count: number): void => {
        this.hot.splice(0, count);
    };
}

type ToolCallUpdateV2 = Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call_update" }>;

type ProjectedAppendV2 =
    | { readonly item: PositionedSessionEventV2; readonly kind: "append" }
    | {
          readonly item: PositionedSessionEventV2;
          readonly kind: "compact-and-append";
          readonly previous: PositionedSessionEventV2;
          readonly toolCallId: string;
      };

type FlushSchedule =
    | { readonly kind: "closed" }
    | { readonly kind: "idle" }
    | { readonly handle: NodeJS.Immediate; readonly kind: "scheduled" };

export interface AcpSessionEventPageV2 {
    readonly events: readonly SessionEventPayloadV2[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly startPosition: number;
    readonly truncated: boolean;
}

export interface AcpSessionEventPositionV2 {
    readonly position: number;
    readonly sessionGenerationId: string;
}

export interface AcpSessionEventStoreV2 {
    readonly append: (sessionId: string, event: SessionEventPayloadV2) => AcpSessionEventPositionV2;
    readonly close: () => void;
    readonly page: (sessionId: string, eventLimit: number, cursor: string | null) => AcpSessionEventPageV2;
    readonly remove: (sessionId: string) => void;
    readonly reset: (sessionId: string) => void;
}

function projectAppend(session: SessionEventsV2, event: SessionEventPayloadV2, position: number): ProjectedAppendV2 {
    if (event.type !== "acp" || event.payload.sessionUpdate !== "tool_call_update") {
        return { item: new PositionedSessionEventV2(event, position), kind: "append" };
    }
    const update = event.payload;
    const previous = session.getToolCallUpdate(update.toolCallId);
    const previousPayload = previous?.event.type === "acp" ? previous.event.payload : undefined;
    const previousUpdate =
        previousPayload?.sessionUpdate === "tool_call" || previousPayload?.sessionUpdate === "tool_call_update"
            ? previousPayload
            : undefined;
    const merged: ToolCallUpdateV2 = {
        ...previousUpdate,
        ...update,
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
    };
    const item = new PositionedSessionEventV2({ payload: merged, type: "acp" }, position);
    return previousPayload?.sessionUpdate !== "tool_call_update" || previous === undefined
        ? { item, kind: "append" }
        : {
              item,
              kind: "compact-and-append",
              previous: new PositionedSessionEventV2(compactedToolCallUpdate(update.toolCallId), previous.position),
              toolCallId: update.toolCallId,
          };
}

function compactedToolCallUpdate(toolCallId: string): SessionEventPayloadV2 {
    // Positions are pagination cursors, so retain an ID-only event instead of deleting the superseded update.
    return { payload: { sessionUpdate: "tool_call_update", toolCallId }, type: "acp" };
}

function eventPage(
    sessionGenerationId: string,
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
        sessionGenerationId,
        startPosition: startPosition + 1,
        truncated: startPosition > 0,
    };
}

export function pageAcpSessionEventsV2(
    sessionGenerationId: string,
    events: readonly SessionEventPayloadV2[],
    eventLimit: number,
    cursor: string | null,
): AcpSessionEventPageV2 {
    return eventPage(sessionGenerationId, events.length, eventLimit, cursor, (startPosition, endPosition) =>
        events.slice(startPosition - 1, endPosition),
    );
}

export class MemoryAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #events = new Map<string, SessionEventsV2>();

    readonly #session = (sessionId: string): SessionEventsV2 => {
        const session = this.#events.get(sessionId) ?? new SessionEventsV2();
        this.#events.set(sessionId, session);
        return session;
    };

    readonly append = (sessionId: string, event: SessionEventPayloadV2): AcpSessionEventPositionV2 => {
        const session = this.#session(sessionId);
        const position = session.nextPosition;
        const projected = projectAppend(session, event, position);
        if (projected.kind === "compact-and-append") {
            session.updateToolCallUpdate(projected.toolCallId, projected.previous);
        }
        session.append(projected.item);
        session.nextPosition += 1;
        return { position, sessionGenerationId: session.sessionGenerationId };
    };

    readonly close = (): void => this.#events.clear();

    readonly page = (sessionId: string, eventLimit: number, cursor: string | null): AcpSessionEventPageV2 => {
        const session = this.#session(sessionId);
        return eventPage(session.sessionGenerationId, session.nextPosition - 1, eventLimit, cursor, (start, end) =>
            session.hot.slice(start - 1, end).map(({ event }) => event),
        );
    };

    readonly remove = (sessionId: string): void => {
        this.#events.delete(sessionId);
    };

    readonly reset = (sessionId: string): void => {
        this.#events.set(sessionId, new SessionEventsV2());
    };
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
        sessionGenerationId: "cached-generation",
        sessionId: "cached-session",
    });
    return event.type === "acp"
        ? { payload: event.payload, type: event.type }
        : { payload: event.payload, type: event.type };
}

export class CachedAcpSessionEventStoreV2 implements AcpSessionEventStoreV2 {
    readonly #database: NodeSQLiteDatabase;
    readonly #ignoredPersistedSessions = new Set<string>();
    readonly #localDatabase: LocalSqliteDatabase;
    readonly #sessions = new Map<string, SessionEventsV2>();
    #flushSchedule: FlushSchedule = { kind: "idle" };
    #isLocalDBAvailable = true;

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

    readonly #session = (sessionId: string): SessionEventsV2 => {
        const session = this.#sessions.get(sessionId) ?? new SessionEventsV2();
        this.#sessions.set(sessionId, session);
        return session;
    };

    readonly append = (sessionId: string, event: SessionEventPayloadV2): AcpSessionEventPositionV2 => {
        if (this.#flushSchedule.kind === "closed") {
            throw new Error("The V2 Session event store is closed");
        }
        const session = this.#session(sessionId);
        const position = session.nextPosition;
        const projected = projectAppend(session, event, position);
        if (projected.kind === "compact-and-append") {
            this.#updateToolCallUpdate(sessionId, session, projected.toolCallId, projected.previous);
        }
        session.append(projected.item);
        session.nextPosition += 1;
        this.#sessions.set(sessionId, session);
        if (session.hot.length > HOT_EVENT_HIGH_WATER_MARK) {
            this.#scheduleFlush();
        }
        return { position, sessionGenerationId: session.sessionGenerationId };
    };

    readonly #updateToolCallUpdate = (
        sessionId: string,
        session: SessionEventsV2,
        toolCallId: string,
        item: PositionedSessionEventV2,
    ): void => {
        if (!session.updateToolCallUpdate(toolCallId, item) || !this.#isLocalDBAvailable) {
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
                        eq(sessionEventV2.position, item.position),
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
                          sessionGenerationId: session.sessionGenerationId,
                          sessionId,
                      },
                  ];
        });
        const values = batches.flatMap((batch) =>
            batch.events.map(({ event, position }) => ({
                eventJson: JSON.stringify(event),
                generationId: batch.sessionGenerationId,
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
        const eventCount = current.nextPosition - 1;
        return eventPage(current.sessionGenerationId, eventCount, eventLimit, cursor, (startPosition, endPosition) => {
            const persisted = this.#ignoredPersistedSessions.has(sessionId)
                ? []
                : this.#database
                      .select({ eventJson: sessionEventV2.eventJson, position: sessionEventV2.position })
                      .from(sessionEventV2)
                      .where(
                          and(
                              eq(sessionEventV2.generationId, current.sessionGenerationId),
                              eq(sessionEventV2.sessionId, sessionId),
                              gte(sessionEventV2.position, startPosition),
                              lte(sessionEventV2.position, endPosition),
                          ),
                      )
                      .orderBy(asc(sessionEventV2.position))
                      .all()
                      .map((value): PositionedSessionEventV2 => {
                          const row = cachedEventRowSchema.parse(value);
                          return new PositionedSessionEventV2(
                              decodeCachedEvent(JSON.parse(row.eventJson)),
                              row.position,
                          );
                      });
            const hot = (session?.hot ?? []).filter(
                ({ position }) => position >= startPosition && position <= endPosition,
            );
            return [...persisted, ...hot]
                .toSorted((left, right) => left.position - right.position)
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
    };

    readonly reset = (sessionId: string): void => {
        const previous = this.#sessions.get(sessionId);
        this.#deletePersisted(sessionId, previous?.sessionGenerationId);
        this.#sessions.set(sessionId, new SessionEventsV2());
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
    };
}
