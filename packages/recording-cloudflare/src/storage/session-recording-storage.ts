import {
    decodeSessionEventEnvelopeV2,
    encodeSessionEventEnvelopeV2,
    type SessionLiveEventV2,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

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

interface ResolvedCursor {
    readonly index: number;
    readonly legacy: boolean;
    readonly ordinal: number;
}

/** Stored batch bounds read without decoding the envelope, so a late page never pays for earlier history. */
interface CompleteBatchBounds {
    readonly firstPosition: number;
    readonly generation: string;
    readonly lastPosition: number;
    readonly ordinal: number;
}

/** Where a paged read resumes: the first candidate batch, its already-delivered prefix, and its generation. */
interface BoundedCursor {
    readonly generation: string;
    readonly index: number;
    readonly legacy: boolean;
    readonly start: number;
}

interface RecordedEvent {
    readonly event: SessionLiveEventV2;
    readonly index: number;
    readonly ordinal: number;
}

/** Stored batches decoded per page read. A page rarely spans more than one window. */
const DECODE_BATCH_WINDOW = 8;

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

    readonly #batches = (): readonly RecordedBatch[] =>
        this.#database
            .select({
                envelopeJson: recordedSessionEvent.envelopeJson,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all()
            .map((row) => {
                const events = this.#decode(row);
                return {
                    events,
                    generation: row.sessionGenerationId ?? events[0]?.sessionGenerationId ?? "",
                    ordinal: row.ordinal,
                };
            });

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
        const bounds = this.#batchBounds();
        // Batches recorded before the position and generation columns were backfilled carry no
        // usable bounds, so their pages fall back to the decode-everything reader instead of guessing.
        if (bounds === null) {
            return this.#readPageWithoutBounds(sessionId, after, limit);
        }
        const cursor = this.#resolveBoundedCursor(bounds, after);
        if (cursor === null) {
            throw new Error("The Recording cursor is invalid");
        }
        const newest = bounds.at(-1);
        const tailCursor = newest === undefined ? "v2:0:0" : `v2:${newest.ordinal}:${newest.lastPosition}`;
        // Position-only legacy cursors have no generation scope. Once a generation switch exists,
        // replay the full durable history so clients replace reconstructed state instead of dropping it.
        const replay = cursor.legacy && this.#hasBoundedGenerationReset(bounds);
        const selected = replay
            ? this.#selectFrom(bounds, 0, -1, "", limit)
            : this.#selectFrom(bounds, cursor.start, cursor.index, cursor.generation, limit);
        return {
            events: selected.events.map((recorded) => recorded.event),
            generationReset: replay || selected.generationReset,
            nextCursor: this.#nextCursor(selected.events),
            sessionId,
            tailCursor,
            truncated: selected.truncated,
            version: 2,
        };
    };

    readonly #nextCursor = (selected: readonly RecordedEvent[]): string | null => {
        const last = selected.at(-1);
        return last === undefined ? null : `v2:${last.ordinal}:${last.event.position}`;
    };

    /**
     * Reads every stored batch bound without decoding envelopes, or null when any batch predates
     * the position columns and can only be resolved by decoding.
     */
    readonly #batchBounds = (): readonly CompleteBatchBounds[] | null => {
        const bounds: CompleteBatchBounds[] = [];
        const rows = this.#database
            .select({
                firstPosition: recordedSessionEvent.firstPosition,
                lastPosition: recordedSessionEvent.lastPosition,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all();
        for (const row of rows) {
            if (row.firstPosition === null || row.lastPosition === null) {
                return null;
            }
            bounds.push({
                firstPosition: row.firstPosition,
                generation: row.sessionGenerationId ?? "",
                lastPosition: row.lastPosition,
                ordinal: row.ordinal,
            });
        }
        return bounds;
    };

    /**
     * Collects up to `limit` events from batches at or after `start`, decoding only the batches the
     * page actually reaches. `skipThroughIndex` drops the already-delivered prefix of the starting
     * batch, and `cursorGeneration` decides whether a later generation is a reset.
     */
    readonly #selectFrom = (
        bounds: readonly CompleteBatchBounds[],
        start: number,
        skipThroughIndex: number,
        cursorGeneration: string,
        limit: number,
    ): {
        readonly events: readonly RecordedEvent[];
        readonly generationReset: boolean;
        readonly truncated: boolean;
    } => {
        const events: RecordedEvent[] = [];
        const startOrdinal = bounds[start]?.ordinal;
        let truncated = false;
        let generationReset = false;
        for (let window = start; window < bounds.length && !truncated; window += DECODE_BATCH_WINDOW) {
            for (const batch of this.#decodedBatches(bounds.slice(window, window + DECODE_BATCH_WINDOW))) {
                if (batch.generation !== cursorGeneration) {
                    generationReset = true;
                }
                for (const [index, event] of batch.events.entries()) {
                    if (batch.ordinal === startOrdinal && index <= skipThroughIndex) {
                        continue;
                    }
                    if (events.length >= limit) {
                        truncated = true;
                        break;
                    }
                    events.push({ event, index, ordinal: batch.ordinal });
                }
                if (truncated) {
                    break;
                }
            }
        }
        return { events, generationReset, truncated };
    };

    /** Decodes exactly the listed stored batches, oldest first. */
    readonly #decodedBatches = (bounds: readonly CompleteBatchBounds[]): readonly RecordedBatch[] => {
        if (bounds.length === 0) {
            return [];
        }
        return this.#database
            .select({
                envelopeJson: recordedSessionEvent.envelopeJson,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .where(
                inArray(
                    recordedSessionEvent.ordinal,
                    bounds.map((batch) => batch.ordinal),
                ),
            )
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all()
            .map((row) => {
                const events = this.#decode(row);
                return {
                    events,
                    generation: row.sessionGenerationId ?? events[0]?.sessionGenerationId ?? "",
                    ordinal: row.ordinal,
                };
            });
    };

    /** Resolves a cursor against stored bounds, decoding at most the batch the cursor lands inside. */
    readonly #resolveBoundedCursor = (bounds: readonly CompleteBatchBounds[], after: string): BoundedCursor | null => {
        const [cursorKind, ordinalToken, positionToken] = after.split(":");
        if (cursorKind === "v2" && ordinalToken !== undefined && positionToken !== undefined) {
            const ordinal = Number(ordinalToken);
            const start = bounds.findIndex((candidate) => candidate.ordinal === ordinal);
            if (start === -1) {
                return null;
            }
            const decoded = this.#decodedBatches(bounds.slice(start, start + 1))[0];
            const index = decoded?.events.findIndex((event) => Number(event.position) === Number(positionToken)) ?? -1;
            if (index === -1) {
                return null;
            }
            // Ordinal zero carries no generation scope, matching the append-order cursor contract.
            const generation = ordinal === 0 ? "" : (bounds[start]?.generation ?? "");
            return { generation, index, legacy: false, start };
        }
        if (!/^(?:0|[1-9][0-9]*)$/.test(after)) {
            return null;
        }
        const position = Number(after);
        let cursor: BoundedCursor = { generation: "", index: -1, legacy: true, start: 0 };
        let generation: string | null = null;
        let previousPosition = 0;
        for (const [start, batch] of bounds.entries()) {
            if (generation !== null && batch.generation !== generation) {
                return cursor;
            }
            generation = batch.generation;
            if (batch.firstPosition < previousPosition) {
                return cursor;
            }
            if (batch.lastPosition <= position) {
                // The whole batch is at or before the cursor, so delivery resumes with the next one.
                cursor = { generation: batch.generation, index: -1, legacy: true, start: start + 1 };
                previousPosition = batch.lastPosition;
                continue;
            }
            if (batch.firstPosition <= position) {
                // The cursor lands inside this batch, so it is the only batch that must be decoded.
                const decoded = this.#decodedBatches([batch])[0];
                let index = -1;
                for (const [candidateIndex, event] of (decoded?.events ?? []).entries()) {
                    const current = Number(event.position);
                    if (current < previousPosition) {
                        return cursor;
                    }
                    if (current <= position) {
                        index = candidateIndex;
                    }
                    previousPosition = current;
                }
                cursor = { generation: batch.generation, index, legacy: true, start };
                continue;
            }
            return cursor;
        }
        return cursor;
    };

    readonly #hasBoundedGenerationReset = (bounds: readonly CompleteBatchBounds[]): boolean => {
        let previousGeneration: string | null = null;
        let previousPosition = 0;
        for (const batch of bounds) {
            if (
                previousGeneration !== null &&
                (batch.generation !== previousGeneration || batch.firstPosition < previousPosition)
            ) {
                return true;
            }
            previousGeneration = batch.generation;
            previousPosition = batch.lastPosition;
        }
        return false;
    };

    /**
     * Legacy reader for batches without stored bounds. It decodes the whole Recording, so it stays
     * reachable only for rows recorded before the bound columns existed.
     */
    readonly #readPageWithoutBounds = (
        sessionId: string,
        after: string,
        limit: number,
    ): RecordedSessionLiveHistoryPage => {
        const batches = this.#batches();
        const cursor = this.#resolveCursor(batches, after);
        if (cursor === null) {
            throw new Error("The Recording cursor is invalid");
        }
        const tail = batches.at(-1);
        const tailCursor = tail === undefined ? "v2:0:0" : this.#cursor(tail, tail.events.length - 1);
        let selected: SelectedEvent[] = [];
        let truncated = false;
        let generationReset = false;
        for (const batch of batches) {
            if (batch.ordinal < cursor.ordinal) {
                continue;
            }
            if (batch.generation !== this.#cursorGeneration(batches, cursor.ordinal)) {
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
        if (cursor.legacy && this.#hasGenerationReset(batches)) {
            selected = [];
            truncated = false;
            generationReset = true;
            for (const batch of batches) {
                for (const [index, event] of batch.events.entries()) {
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

    readonly #resolveCursor = (batches: readonly RecordedBatch[], after: string): ResolvedCursor | null => {
        const [cursorKind, ordinalToken, positionToken] = after.split(":");
        if (cursorKind === "v2" && ordinalToken !== undefined && positionToken !== undefined) {
            const ordinal = Number(ordinalToken);
            const batch = batches.find((candidate) => candidate.ordinal === ordinal);
            if (batch === undefined) {
                return null;
            }
            const index = batch.events.findIndex((event) => Number(event.position) === Number(positionToken));
            return index === -1 ? null : { index, legacy: false, ordinal };
        }
        if (!/^(?:0|[1-9][0-9]*)$/.test(after)) {
            return null;
        }
        const position = Number(after);
        let cursor: ResolvedCursor = { index: -1, legacy: true, ordinal: 0 };
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
                    cursor = { index, legacy: true, ordinal: batch.ordinal };
                }
                previousPosition = current;
            }
        }
        return cursor;
    };

    readonly #cursorGeneration = (batches: readonly RecordedBatch[], ordinal: number): string => {
        if (ordinal === 0) {
            return "";
        }
        return batches.find((batch) => batch.ordinal === ordinal)?.generation ?? "";
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
