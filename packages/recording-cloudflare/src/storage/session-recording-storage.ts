import {
    decodeSessionEventEnvelopeV2,
    encodeSessionEventEnvelopeV2,
    type SessionLiveEventV2,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

// Batches are fetched in growing rounds so a page costs a few queries without reading the whole
// Session. Decoding stays lazy per row, so filling a small page never decodes a later round.
const initialBatchFetchSize = 4;
const maximumBatchFetchSize = 64;

const batchColumns = {
    envelopeJson: recordedSessionEvent.envelopeJson,
    ordinal: recordedSessionEvent.ordinal,
    sessionGenerationId: recordedSessionEvent.sessionGenerationId,
} as const;

interface BatchRow {
    readonly envelopeJson: string;
    readonly ordinal: number;
    readonly sessionGenerationId: string | null;
}

interface RecordedBatch {
    readonly events: readonly SessionLiveEventV2[];
    readonly generation: string;
    readonly ordinal: number;
}

interface SelectedEvent {
    readonly batch: RecordedBatch;
    readonly event: SessionLiveEventV2;
    readonly index: number;
}

/** A caller-supplied cursor, before it is resolved against recorded batches. */
type RequestedCursor =
    | { readonly kind: "v2"; readonly ordinal: number; readonly position: number }
    | { readonly kind: "legacy"; readonly position: number };

/**
 * Where a page starts reading. A v2 cursor names its batch, so reading is windowed forward from
 * there; a legacy position cursor has no generation scope and still needs the whole Session.
 */
type CursorScope =
    | { readonly kind: "v2"; readonly cursor: ResolvedCursor; readonly batches: Generator<RecordedBatch> }
    | { readonly kind: "legacy"; readonly cursor: ResolvedCursor; readonly history: readonly RecordedBatch[] };

interface ResolvedCursor {
    /** The generation the cursor points into, so pages need not rescan for it per batch. */
    readonly generation: string;
    readonly index: number;
    readonly ordinal: number;
}

const legacyPositionCursorPattern = /^(?:0|[1-9][0-9]*)$/;

/**
 * Splits a caller cursor into the two supported kinds. A v2 cursor names the batch that holds its
 * position, which is what lets a page start reading there; a legacy cursor carries only a position.
 */
function parseRequestedCursor(after: string): RequestedCursor | null {
    const [cursorKind, ordinalToken, positionToken] = after.split(":");
    if (cursorKind === "v2" && ordinalToken !== undefined && positionToken !== undefined) {
        return { kind: "v2", ordinal: Number(ordinalToken), position: Number(positionToken) };
    }
    return legacyPositionCursorPattern.test(after) ? { kind: "legacy", position: Number(after) } : null;
}

interface RecordedSessionLiveHistory {
    readonly events: readonly SessionLiveEventV2[];
    readonly sessionId: string;
}

interface RecordedSessionLiveHistoryPage extends RecordedSessionLiveHistory {
    readonly generationReset: boolean;
    readonly nextCursor: string | null;
    readonly tailCursor: string;
    readonly truncated: boolean;
    readonly version: 2;
}

export class SessionRecordingStorage {
    readonly #database;
    readonly #storage: DurableObjectStorage;
    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
    }

    readonly #batches = (): readonly RecordedBatch[] => this.#batchRows(0, null).map(this.#toBatch);

    /** The newest recorded batch, so a page can report the tail without reading the whole Session. */
    readonly #tailBatch = (): RecordedBatch | undefined => {
        const row = this.#database
            .select(batchColumns)
            .from(recordedSessionEvent)
            .orderBy(desc(recordedSessionEvent.ordinal))
            .limit(1)
            .get();
        return row === undefined ? undefined : this.#toBatch(row);
    };

    /**
     * Yields decoded batches in append order from `first` onwards, fetching in growing windows.
     * A page that fills early stops pulling, so later batches are neither read nor decoded.
     */
    *#batchesFrom(first: RecordedBatch): Generator<RecordedBatch> {
        yield first;
        let window = initialBatchFetchSize;
        let afterOrdinal = first.ordinal;
        for (;;) {
            const rows = this.#batchRows(afterOrdinal, window);
            let lastOrdinal = afterOrdinal;
            for (const row of rows) {
                lastOrdinal = row.ordinal;
                yield this.#toBatch(row);
            }
            if (rows.length < window) {
                return;
            }
            afterOrdinal = lastOrdinal;
            window = Math.min(window * 2, maximumBatchFetchSize);
        }
    }

    readonly #batchRows = (afterOrdinal: number, size: number | null) => {
        const query = this.#database
            .select(batchColumns)
            .from(recordedSessionEvent)
            // Ordinals are 1-based autoincrement keys, so 0 selects the whole Session.
            .where(gt(recordedSessionEvent.ordinal, afterOrdinal))
            .orderBy(asc(recordedSessionEvent.ordinal));
        return (size === null ? query : query.limit(size)).all();
    };

    /** The single batch a v2 cursor names, or undefined when that ordinal was never recorded. */
    readonly #batchAt = (ordinal: number): RecordedBatch | undefined => {
        const row = this.#database
            .select(batchColumns)
            .from(recordedSessionEvent)
            .where(eq(recordedSessionEvent.ordinal, ordinal))
            .limit(1)
            .get();
        return row === undefined ? undefined : this.#toBatch(row);
    };

    readonly #toBatch = (row: BatchRow): RecordedBatch => {
        const events = this.#decode(row);
        return {
            events,
            generation: row.sessionGenerationId ?? events[0]?.sessionGenerationId ?? "",
            ordinal: row.ordinal,
        };
    };

    readonly #cursor = (batch: RecordedBatch, index: number): string =>
        `v2:${batch.ordinal}:${batch.events[index]?.position ?? "0"}`;

    readonly append = (write: SessionRecordingWrite): boolean =>
        this.#storage.transactionSync(() => {
            const [event, ...remainingEvents] = write.envelope.events;
            if (event === undefined || remainingEvents.some((candidate) => candidate.sessionId !== event.sessionId)) {
                return false;
            }
            const finalEvent = write.envelope.events.at(-1);
            const metadata = this.#database
                .select()
                .from(recordingMetadata)
                .where(eq(recordingMetadata.singleton, 1))
                .get();
            if (
                metadata !== undefined &&
                (metadata.projectId !== write.projectId ||
                    metadata.runtimeId !== write.runtimeId ||
                    metadata.sessionId !== event.sessionId)
            ) {
                return false;
            }
            if (metadata === undefined) {
                this.#database
                    .insert(recordingMetadata)
                    .values({
                        singleton: 1,
                        projectId: write.projectId,
                        runtimeId: write.runtimeId,
                        sessionId: event.sessionId,
                        createdAt: Date.parse(event.recordedAt),
                    })
                    .run();
            }
            this.#database
                .insert(recordedSessionEvent)
                .values({
                    envelopeJson: encodeSessionEventEnvelopeV2(write.envelope),
                    firstPosition: Number(event.position),
                    lastPosition: finalEvent === undefined ? Number(event.position) : Number(finalEvent.position),
                    recordedAt: Date.parse(event.recordedAt),
                    sessionGenerationId: event.sessionGenerationId,
                })
                .run();
            return true;
        });
    readonly read = (projectId: string, runtimeId: string, sessionId: string): RecordedSessionLiveHistory | null => {
        const rows = this.#requireMetadata(projectId, runtimeId, sessionId);
        if (rows === null) {
            return null;
        }
        return { events: rows.flatMap((row) => this.#decode(row)), sessionId };
    };
    /** Reads events after an opaque append-order cursor in a bounded page. */
    readonly readPage = (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        after: string,
        limit: number,
    ): RecordedSessionLiveHistoryPage | null => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return null;
        }
        const requested = parseRequestedCursor(after);
        if (requested === null) {
            throw new Error("The Recording cursor is invalid");
        }
        const tail = this.#tailBatch();
        const tailCursor = tail === undefined ? "v2:0:0" : this.#cursor(tail, tail.events.length - 1);
        const scope = requested.kind === "v2" ? this.#v2Scope(requested, tail) : this.#legacyScope(requested.position);
        if (scope === null) {
            throw new Error("The Recording cursor is invalid");
        }
        const page =
            scope.kind === "v2"
                ? this.#selectFrom(scope.batches, scope.cursor, scope.cursor.generation, limit)
                : this.#selectLegacy(scope.history, scope.cursor, limit);
        const last = page.selected.at(-1);
        return {
            events: page.selected.map(({ event }) => event),
            nextCursor: last === undefined ? null : this.#cursor(last.batch, last.index),
            sessionId,
            tailCursor,
            truncated: page.truncated,
            generationReset: page.generationReset,
            version: 2,
        };
    };

    /**
     * Resolves a v2 cursor to the batch it names and a read window starting there. The cursor's
     * generation comes from that batch, so no earlier history is read to scope the page.
     */
    readonly #v2Scope = (
        requested: { readonly ordinal: number; readonly position: number },
        tail: RecordedBatch | undefined,
    ): CursorScope | null => {
        // Reuse the tail when the cursor already points at it, which is the common caught-up poll.
        const anchor =
            tail !== undefined && tail.ordinal === requested.ordinal ? tail : this.#batchAt(requested.ordinal);
        if (anchor === undefined) {
            return null;
        }
        const index = anchor.events.findIndex((event) => Number(event.position) === requested.position);
        if (index === -1) {
            return null;
        }
        return {
            batches: this.#batchesFrom(anchor),
            cursor: { generation: anchor.generation, index, ordinal: anchor.ordinal },
            kind: "v2",
        };
    };

    /**
     * Resolves a position-only legacy cursor. It has no generation scope, so locating it and
     * detecting a generation switch both need the full recorded history.
     */
    readonly #legacyScope = (position: number): CursorScope | null => {
        const history = this.#batches();
        return { cursor: this.#resolveLegacyCursor(history, position), history, kind: "legacy" };
    };

    /**
     * Collects up to `limit` events at or after the cursor. Batches are pulled on demand, so a page
     * that fills early never reads the rest of the Session; the one batch past the fill point is
     * still reached, which is what makes `truncated` and a late generation switch observable.
     */
    readonly #selectFrom = (
        batches: Iterable<RecordedBatch>,
        cursor: ResolvedCursor,
        cursorGeneration: string,
        limit: number,
    ): { readonly generationReset: boolean; readonly selected: SelectedEvent[]; readonly truncated: boolean } => {
        const selected: SelectedEvent[] = [];
        let truncated = false;
        let generationReset = false;
        for (const batch of batches) {
            if (batch.ordinal < cursor.ordinal) {
                continue;
            }
            if (batch.generation !== cursorGeneration) {
                generationReset = true;
            }
            for (const [index, event] of batch.events.entries()) {
                if (batch.ordinal === cursor.ordinal && index <= cursor.index) {
                    continue;
                }
                if (selected.length >= limit) {
                    truncated = true;
                    break;
                }
                selected.push({ batch, event, index });
            }
            if (truncated) {
                break;
            }
        }
        return { generationReset, selected, truncated };
    };

    readonly #selectLegacy = (
        history: readonly RecordedBatch[],
        cursor: ResolvedCursor,
        limit: number,
    ): { readonly generationReset: boolean; readonly selected: SelectedEvent[]; readonly truncated: boolean } => {
        const page = this.#selectFrom(history, cursor, cursor.generation, limit);
        // Position-only legacy cursors have no generation scope. Once a generation switch exists,
        // replay the full durable history so clients replace reconstructed state instead of dropping it.
        if (!this.#hasGenerationReset(history)) {
            return page;
        }
        const replayed = this.#selectFrom(history, { generation: "", index: -1, ordinal: 0 }, "", limit);
        return { ...replayed, generationReset: true };
    };

    readonly #resolveLegacyCursor = (batches: readonly RecordedBatch[], position: number): ResolvedCursor => {
        let cursor: ResolvedCursor = { generation: "", index: -1, ordinal: 0 };
        let generation: string | null = null;
        let previousPosition = 0;
        for (const batch of batches) {
            if (generation !== null && batch.generation !== generation) {
                return cursor;
            }
            generation = batch.generation;
            for (const [index, event] of batch.events.entries()) {
                const current = Number(event.position);
                if (current < previousPosition) {
                    return cursor;
                }
                if (current <= position) {
                    cursor = { generation: batch.generation, index, ordinal: batch.ordinal };
                }
                previousPosition = current;
            }
        }
        return cursor;
    };

    readonly #hasGenerationReset = (batches: readonly RecordedBatch[]): boolean => {
        let previousGeneration: string | null = null;
        let previousPosition = 0;
        for (const batch of batches) {
            const firstPosition = Number(batch.events[0]?.position ?? 0);
            const lastPosition = Number(batch.events.at(-1)?.position ?? previousPosition);
            if (
                previousGeneration !== null &&
                (batch.generation !== previousGeneration || firstPosition < previousPosition)
            ) {
                return true;
            }
            previousGeneration = batch.generation;
            previousPosition = lastPosition;
        }
        return false;
    };
    readonly #metadata = (projectId: string, runtimeId: string, sessionId: string) =>
        this.#database
            .select()
            .from(recordingMetadata)
            .where(
                and(
                    eq(recordingMetadata.singleton, 1),
                    eq(recordingMetadata.projectId, projectId),
                    eq(recordingMetadata.runtimeId, runtimeId),
                    eq(recordingMetadata.sessionId, sessionId),
                ),
            )
            .get();
    /** Returns the stored batches, or null when this Session has no recording here. */
    readonly #requireMetadata = (projectId: string, runtimeId: string, sessionId: string) => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return null;
        }
        return this.#database
            .select({ envelopeJson: recordedSessionEvent.envelopeJson })
            .from(recordedSessionEvent)
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all();
    };
    readonly #decode = (row: { readonly envelopeJson: string }): readonly SessionLiveEventV2[] =>
        decodeSessionEventEnvelopeV2(JSON.parse(row.envelopeJson)).events;
}
