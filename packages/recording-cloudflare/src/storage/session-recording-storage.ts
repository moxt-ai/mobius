import {
    decodeSessionEventEnvelopeV2,
    encodeSessionEventEnvelopeV2,
    type SessionEventV2,
    type SessionRecordingHistory,
    type SessionRecordingHistoryPage,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

interface RecordedBatch {
    readonly events: readonly SessionEventV2[];
    readonly generation: string;
    readonly ordinal: number;
}

interface SelectedEvent {
    readonly batch: RecordedBatch;
    readonly event: SessionEventV2;
    readonly index: number;
}

interface ResolvedCursor {
    readonly index: number;
    readonly legacy: boolean;
    readonly ordinal: number;
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
    readonly read = (projectId: string, runtimeId: string, sessionId: string): SessionRecordingHistory | null => {
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
    ): SessionRecordingHistoryPage | null => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return null;
        }
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
        // Position-only legacy cursors have no generation scope. Once a generation switch exists,
        // replay the full durable history so clients replace reconstructed state instead of dropping it.
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
    readonly #decode = (row: { readonly envelopeJson: string }): readonly SessionEventV2[] =>
        decodeSessionEventEnvelopeV2(JSON.parse(row.envelopeJson)).events;
}
