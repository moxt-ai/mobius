import {
    decodeSessionEventEnvelopeV2,
    decodeSessionLiveEventV3,
    encodeSessionEventEnvelopeV2,
    encodeSessionLiveEventV3,
    type SessionEventV2,
    type SessionRecordingHistory,
    type SessionRecordingHistoryPage,
    type SessionRecordingPageV3,
    type SessionRecordingWrite,
    type SessionRecordingWriteV3,
} from "@moxt-ai/mobius-protocol";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import {
    recordedSessionEvent,
    recordedSessionLiveEventV3,
    recordingMetadata,
} from "../schema/session-recording-do/index.ts";
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

export type SessionRecordingAppendResultV3 =
    | { readonly kind: "recorded" }
    | { readonly code: "recording_identity_conflict" | "recording_sequence_conflict"; readonly kind: "conflict" };

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
    readonly appendV3 = (write: SessionRecordingWriteV3): SessionRecordingAppendResultV3 =>
        this.#storage.transactionSync(() => {
            const [event] = write.envelope.events;
            if (
                event === undefined ||
                write.envelope.events.some((candidate) => candidate.sessionId !== event.sessionId)
            ) {
                return { code: "recording_identity_conflict", kind: "conflict" };
            }
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
                return { code: "recording_identity_conflict", kind: "conflict" };
            }
            if (metadata === undefined) {
                this.#database
                    .insert(recordingMetadata)
                    .values({
                        createdAt: Date.parse(write.recordedAt),
                        projectId: write.projectId,
                        runtimeId: write.runtimeId,
                        sessionId: event.sessionId,
                        singleton: 1,
                    })
                    .run();
            }
            const encoded = write.envelope.events.map((candidate) => ({
                event: candidate,
                eventJson: encodeSessionLiveEventV3(candidate),
            }));
            for (const candidate of encoded) {
                const existing = this.#database
                    .select({ eventJson: recordedSessionLiveEventV3.eventJson })
                    .from(recordedSessionLiveEventV3)
                    .where(eq(recordedSessionLiveEventV3.seq, candidate.event.seq))
                    .get();
                if (existing !== undefined && existing.eventJson !== candidate.eventJson) {
                    return { code: "recording_sequence_conflict", kind: "conflict" };
                }
            }
            for (const candidate of encoded) {
                this.#database
                    .insert(recordedSessionLiveEventV3)
                    .values({
                        eventJson: candidate.eventJson,
                        recordedAt: Date.parse(write.recordedAt),
                        seq: candidate.event.seq,
                    })
                    .onConflictDoNothing()
                    .run();
            }
            return { kind: "recorded" };
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
    readonly readPageV3 = (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        after: number,
        limit: number,
    ): SessionRecordingPageV3 | null => {
        if (this.#metadata(projectId, runtimeId, sessionId) === undefined) {
            return null;
        }
        const rows = this.#database
            .select()
            .from(recordedSessionLiveEventV3)
            .where(gt(recordedSessionLiveEventV3.seq, after))
            .orderBy(asc(recordedSessionLiveEventV3.seq))
            .limit(limit)
            .all();
        const tailSeq =
            this.#database
                .select({ seq: recordedSessionLiveEventV3.seq })
                .from(recordedSessionLiveEventV3)
                .orderBy(desc(recordedSessionLiveEventV3.seq))
                .limit(1)
                .get()?.seq ?? 0;
        const nextCursor = rows.at(-1)?.seq ?? null;
        const gaps: Array<{ readonly fromSeq: number; readonly toSeq: number }> = [];
        let expected = after + 1;
        for (const row of rows) {
            if (row.seq > expected) {
                gaps.push({ fromSeq: expected, toSeq: row.seq - 1 });
            }
            expected = row.seq + 1;
        }
        return {
            events: rows.map((row) => ({
                event: decodeSessionLiveEventV3(row.eventJson),
                recordedAt: new Date(row.recordedAt).toISOString(),
            })),
            gaps,
            nextCursor,
            sessionId,
            tailSeq,
            version: 3,
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
