import {
    decodeSessionEventEnvelope,
    encodeSessionEventEnvelope,
    type SessionLiveEvent,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-sdk/protocol";
import { and, asc, desc, eq, gt, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

export interface RecordedBatch {
    readonly events: readonly SessionLiveEvent[];
    readonly generation: string;
    readonly ordinal: number;
}

interface SelectedEvent {
    readonly batch: RecordedBatch;
    readonly event: SessionLiveEvent;
    readonly index: number;
}

interface ResolvedCursor {
    readonly generation: string;
    readonly index: number;
    readonly legacy: boolean;
    readonly ordinal: number;
}

interface BatchSummary {
    readonly firstPosition: number | null;
    readonly lastPosition: number | null;
    readonly ordinal: number;
    readonly sessionGenerationId: string | null;
}

interface BatchBounds {
    readonly firstPosition: number;
    readonly generation: string;
    readonly lastPosition: number;
}

/** Batches decoded per query while paging; small enough that one read stays far below Durable Object memory. */
const batchReadChunk = 32;

interface RecordedSessionHistory {
    readonly events: readonly SessionLiveEvent[];
    readonly sessionId: string;
}

interface RecordedSessionHistoryPage extends RecordedSessionHistory {
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

    /** Decodes one stored batch; rows written before the generation column existed carry it in their events. */
    readonly #batch = (row: {
        readonly envelopeJson: string;
        readonly ordinal: number;
        readonly sessionGenerationId: string | null;
    }): RecordedBatch => {
        const events = this.#decode(row);
        return {
            events,
            generation: row.sessionGenerationId ?? events[0]?.sessionGenerationId ?? "",
            ordinal: row.ordinal,
        };
    };

    readonly #batchAt = (ordinal: number): RecordedBatch | undefined => {
        const row = this.#database
            .select({
                envelopeJson: recordedSessionEvent.envelopeJson,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .where(eq(recordedSessionEvent.ordinal, ordinal))
            .get();
        return row === undefined ? undefined : this.#batch(row);
    };

    /**
     * Yields batches from an ordinal in bounded chunks so a page decodes only the batches it spans
     * instead of the whole Session, whose size grows without bound over a long-running conversation.
     */
    *#batchesFrom(ordinal: number): Generator<RecordedBatch> {
        let nextOrdinal = ordinal;
        for (;;) {
            const rows = this.#database
                .select({
                    envelopeJson: recordedSessionEvent.envelopeJson,
                    ordinal: recordedSessionEvent.ordinal,
                    sessionGenerationId: recordedSessionEvent.sessionGenerationId,
                })
                .from(recordedSessionEvent)
                .where(gte(recordedSessionEvent.ordinal, nextOrdinal))
                .orderBy(asc(recordedSessionEvent.ordinal))
                .limit(batchReadChunk)
                .all();
            for (const row of rows) {
                yield this.#batch(row);
            }
            const last = rows.at(-1);
            if (last === undefined || rows.length < batchReadChunk) {
                return;
            }
            nextOrdinal = last.ordinal + 1;
        }
    }

    /** Lists batch boundaries from indexed columns without decoding any envelope. */
    readonly #summaries = (): readonly BatchSummary[] =>
        this.#database
            .select({
                firstPosition: recordedSessionEvent.firstPosition,
                lastPosition: recordedSessionEvent.lastPosition,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all();

    /** Rows recorded before the boundary columns existed are decoded to recover the same values. */
    readonly #bounds = (summary: BatchSummary): BatchBounds => {
        if (summary.firstPosition !== null && summary.lastPosition !== null && summary.sessionGenerationId !== null) {
            return {
                firstPosition: summary.firstPosition,
                generation: summary.sessionGenerationId,
                lastPosition: summary.lastPosition,
            };
        }
        const batch = this.#batchAt(summary.ordinal);
        const firstPosition = Number(batch?.events[0]?.position ?? 0);
        return {
            firstPosition,
            generation: batch?.generation ?? "",
            lastPosition: Number(batch?.events.at(-1)?.position ?? firstPosition),
        };
    };

    readonly #tail = () =>
        this.#database
            .select({ lastPosition: recordedSessionEvent.lastPosition, ordinal: recordedSessionEvent.ordinal })
            .from(recordedSessionEvent)
            .orderBy(desc(recordedSessionEvent.ordinal))
            .limit(1)
            .get();

    readonly #tailCursor = (): string => {
        const tail = this.#tail();
        if (tail === undefined) {
            return "v2:0:0";
        }
        if (tail.lastPosition !== null) {
            return `v2:${tail.ordinal}:${tail.lastPosition}`;
        }
        const batch = this.#batchAt(tail.ordinal);
        return batch === undefined ? "v2:0:0" : this.#cursor(batch, batch.events.length - 1);
    };

    readonly #cursor = (batch: RecordedBatch, index: number): string =>
        `v2:${batch.ordinal}:${batch.events[index]?.position ?? "0"}`;

    /**
     * Appends one batch. `project` runs inside the same transaction with the new batch ordinal, so a
     * projection derived from the batch commits or rolls back together with it.
     */
    readonly append = (
        write: SessionRecordingWrite,
        project: (ordinal: number, events: readonly SessionLiveEvent[]) => void = () => undefined,
    ): boolean =>
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
            const inserted = this.#database
                .insert(recordedSessionEvent)
                .values({
                    envelopeJson: encodeSessionEventEnvelope(write.envelope),
                    firstPosition: Number(event.position),
                    lastPosition: finalEvent === undefined ? Number(event.position) : Number(finalEvent.position),
                    recordedAt: Date.parse(event.recordedAt),
                    sessionGenerationId: event.sessionGenerationId,
                })
                .returning({ ordinal: recordedSessionEvent.ordinal })
                .get();
            project(inserted.ordinal, write.envelope.events);
            return true;
        });

    /** True when this Durable Object holds the Recording of exactly this Session. */
    readonly records = (projectId: string, runtimeId: string, sessionId: string): boolean =>
        this.#metadata(projectId, runtimeId, sessionId) !== undefined;

    /** Yields the batches appended after `ordinal`, in append order and bounded decoding chunks. */
    readonly batchesAfter = (ordinal: number): Generator<RecordedBatch> => this.#batchesFrom(ordinal + 1);

    /** True when a batch was appended after `afterOrdinal` and before `beforeOrdinal`. */
    readonly hasBatchBetween = (afterOrdinal: number, beforeOrdinal: number): boolean =>
        this.#database
            .select({ ordinal: recordedSessionEvent.ordinal })
            .from(recordedSessionEvent)
            .where(and(gt(recordedSessionEvent.ordinal, afterOrdinal), lt(recordedSessionEvent.ordinal, beforeOrdinal)))
            .limit(1)
            .get() !== undefined;

    readonly latestOrdinal = (): number => this.#tail()?.ordinal ?? 0;

    /** The cursor at the newest recorded event. */
    readonly tailCursor = (): string => this.#tailCursor();
    readonly read = (projectId: string, runtimeId: string, sessionId: string): RecordedSessionHistory | null => {
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
    ): RecordedSessionHistoryPage | null => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return null;
        }
        const cursor = this.#resolveCursor(after);
        if (cursor === null) {
            throw new Error("The Recording cursor is invalid");
        }
        const tailCursor = this.#tailCursor();
        // Position-only legacy cursors have no generation scope. Once a generation switch exists,
        // replay the full durable history so clients replace reconstructed state instead of dropping it.
        const replay = cursor.legacy && this.#hasGenerationReset();
        const start: ResolvedCursor = replay ? { generation: "", index: -1, legacy: true, ordinal: 0 } : cursor;
        const selected: SelectedEvent[] = [];
        let truncated = false;
        let generationReset = replay;
        for (const batch of this.#batchesFrom(start.ordinal)) {
            if (!replay && batch.generation !== start.generation) {
                generationReset = true;
            }
            for (const [index, event] of batch.events.entries()) {
                if (batch.ordinal === start.ordinal && index <= start.index) {
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
        const last = selected.at(-1);
        return {
            events: selected.map(({ event }) => event),
            nextCursor: last === undefined ? null : this.#cursor(last.batch, last.index),
            sessionId,
            tailCursor,
            truncated,
            generationReset,
            version: 2,
        };
    };

    readonly #resolveCursor = (after: string): ResolvedCursor | null => {
        const [cursorKind, ordinalToken, positionToken] = after.split(":");
        if (cursorKind === "v2" && ordinalToken !== undefined && positionToken !== undefined) {
            const ordinal = Number(ordinalToken);
            const batch = this.#batchAt(ordinal);
            if (batch === undefined) {
                return null;
            }
            const index = batch.events.findIndex((event) => Number(event.position) === Number(positionToken));
            return index === -1 ? null : { generation: batch.generation, index, legacy: false, ordinal };
        }
        if (!/^(?:0|[1-9][0-9]*)$/.test(after)) {
            return null;
        }
        return this.#resolveLegacyCursor(Number(after));
    };

    /**
     * Finds the last event at or before a position in the first contiguous generation run. Batch
     * boundaries come from indexed columns, so only the batch holding the cursor is decoded; the
     * daemon assigns increasing positions inside one batch, so its bounds order its events.
     */
    readonly #resolveLegacyCursor = (position: number): ResolvedCursor => {
        const initial: ResolvedCursor = { generation: "", index: -1, legacy: true, ordinal: 0 };
        let containing: { readonly generation: string; readonly ordinal: number } | null = null;
        let generation: string | null = null;
        let previousPosition = 0;
        for (const summary of this.#summaries()) {
            const bounds = this.#bounds(summary);
            if (
                (generation !== null && bounds.generation !== generation) ||
                bounds.firstPosition < previousPosition ||
                bounds.firstPosition > position
            ) {
                break;
            }
            generation = bounds.generation;
            containing = { generation: bounds.generation, ordinal: summary.ordinal };
            if (bounds.lastPosition > position) {
                break;
            }
            previousPosition = bounds.lastPosition;
        }
        if (containing === null) {
            return initial;
        }
        const batch = this.#batchAt(containing.ordinal);
        let index = -1;
        for (const [candidateIndex, event] of (batch?.events ?? []).entries()) {
            if (Number(event.position) > position) {
                break;
            }
            index = candidateIndex;
        }
        return { generation: containing.generation, index, legacy: true, ordinal: containing.ordinal };
    };

    readonly #hasGenerationReset = (): boolean => {
        let previousGeneration: string | null = null;
        let previousPosition = 0;
        for (const summary of this.#summaries()) {
            const bounds = this.#bounds(summary);
            if (
                previousGeneration !== null &&
                (bounds.generation !== previousGeneration || bounds.firstPosition < previousPosition)
            ) {
                return true;
            }
            previousGeneration = bounds.generation;
            previousPosition = bounds.lastPosition;
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
    readonly #decode = (row: { readonly envelopeJson: string }): readonly SessionLiveEvent[] =>
        decodeSessionEventEnvelope(JSON.parse(row.envelopeJson)).events;
}
