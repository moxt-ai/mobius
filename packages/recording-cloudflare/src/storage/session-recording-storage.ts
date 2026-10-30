import {
    decodeSessionWireEnvelope,
    encodeSessionWireEnvelope,
    type SessionRecordingWireWrite,
    type SessionWireEnvelope,
    type SessionWireEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { and, asc, desc, eq, gt, gte, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
    committedDirectoryOperationsSchema,
    type DirectoryChange,
    directoryOperationSchema,
    type PendingDirectoryChange,
} from "../entity/recording-directory-update.ts";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import { RecordingSqlMetrics } from "../infra/recording-sql-metrics.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import {
    pendingDirectoryUpdate,
    recordedSessionEvent,
    recordingLocation,
    recordingMetadata,
} from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

export interface RecordedBatch {
    readonly events: readonly SessionWireEvent[];
    readonly generation: string;
    readonly ordinal: number;
    readonly receivedAt: number;
}

interface SelectedEvent {
    readonly batch: RecordedBatch;
    readonly event: SessionWireEvent;
    readonly index: number;
}

/** Whether no later event of its batch repeats this event's position, so a cursor at it names it alone. */
function isLastCopy({ batch, event, index }: SelectedEvent): boolean {
    return batch.events.findLastIndex((candidate) => Number(candidate.position) === Number(event.position)) === index;
}

interface ResolvedCursor {
    // The decoded batch the cursor points into, or null when nothing of its batch is left to read.
    readonly batch: RecordedBatch | null;
    readonly generation: string;
    readonly index: number;
    readonly ordinal: number;
}

/** The start of the Recording: before the first event of any batch, in no generation. */
const recordingStart: ResolvedCursor = { batch: null, generation: "", index: -1, ordinal: 0 };

/** Batches decoded per query while paging; small enough that one read stays far below Durable Object memory. */
const batchReadChunk = 32;
/**
 * Recently decoded batches kept in memory, bounded by count and encoded characters. Long-poll readers of a
 * Session's tail all read the batches just appended, so they reuse one decoded copy instead of each
 * parsing and validating it again.
 */
const decodedBatchLimit = 16;
const decodedBatchCharacters = 1_000_000;
/** UTF-8 bytes one stored batch may take. Durable Object SQLite rejects a string or row larger than 2 MB. */
const storedBatchBytes = 1_900_000;
/**
 * Stored batches searched for copies of one write's events, nearest positions first. Copies come from frames a
 * daemon or Relay sends again shortly after the first copy, so they sit in the batches just recorded.
 */
const copySearchBatches = 1024;

/** A Session generation gives each of its events its own increasing position, so the pair names one event. */
function eventIdentity(event: SessionWireEvent): string {
    return JSON.stringify([event.sessionGenerationId, Number(event.position)]);
}

export type AppendOutcome =
    // `copies` counts the write's events that were already recorded, so they were not stored again.
    | { readonly kind: "recorded"; readonly copies: number }
    // Another Project, Runtime, or Session already owns this Recording, or the write names several Sessions.
    | { readonly kind: "identity_conflict" }
    // One event alone is larger than a stored batch, so nothing of the write was recorded.
    | { readonly kind: "event_too_large" };

export type PageRead =
    | { readonly kind: "page"; readonly page: RecordedSessionHistoryPage }
    | { readonly kind: "not_found" }
    // The cursor is well formed but names no recorded event here; the caller has to start over.
    | { readonly kind: "cursor_expired" };

interface StoredBatch {
    readonly encoded: string;
    readonly events: readonly SessionWireEvent[];
}

/**
 * Runs of events that one stored batch holds: one Session generation with increasing positions, so a
 * cursor's position names exactly one event of its batch even when a frame is repeated or a restarted
 * Runtime numbers its events again.
 */
function addressableRuns(events: readonly SessionWireEvent[]): readonly (readonly SessionWireEvent[])[] {
    const runs: SessionWireEvent[][] = [];
    for (const event of events) {
        const run = runs.at(-1);
        const previous = run?.at(-1);
        if (
            run === undefined ||
            previous === undefined ||
            previous.sessionGenerationId !== event.sessionGenerationId ||
            Number(event.position) <= Number(previous.position)
        ) {
            runs.push([event]);
        } else {
            run.push(event);
        }
    }
    return runs;
}

/** Encodes a run as stored batches that each fit one row, or null when one event alone does not fit. */
function storedBatches(
    envelope: SessionWireEnvelope,
    events: readonly SessionWireEvent[],
): readonly StoredBatch[] | null {
    const encoded = encodeSessionWireEnvelope({ ...envelope, events });
    if (encoded.length * 3 <= storedBatchBytes || new TextEncoder().encode(encoded).byteLength <= storedBatchBytes) {
        return [{ encoded, events }];
    }
    if (events.length === 1) {
        return null;
    }
    const middle = Math.ceil(events.length / 2);
    const head = storedBatches(envelope, events.slice(0, middle));
    const tail = storedBatches(envelope, events.slice(middle));
    return head === null || tail === null ? null : [...head, ...tail];
}

export type RecordingLocation = "local" | "legacy";

/**
 * The Runtime whose history a legacy Session object holds. An object that never recorded has no tables, and this
 * read leaves it without any, so probing a Session's legacy object does not create one.
 */
export function legacyRecordingOwner(storage: DurableObjectStorage): string | null {
    const created = storage.sql
        .exec("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'recording_metadata'")
        .toArray();
    if (created.length === 0) {
        return null;
    }
    return (
        drizzle(storage, { schema })
            .select({ runtimeId: recordingMetadata.runtimeId })
            .from(recordingMetadata)
            .where(eq(recordingMetadata.singleton, 1))
            .all()[0]?.runtimeId ?? null
    );
}

interface RecordedSessionHistory {
    readonly events: readonly SessionWireEvent[];
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
    // Stored batches never change once appended, so a decoded copy stays valid for the life of this object.
    readonly #decoded = new Map<number, { readonly batch: RecordedBatch; readonly characters: number }>();
    #decodedCharacters = 0;
    constructor(storage: DurableObjectStorage, metrics: RecordingSqlMetrics = new RecordingSqlMetrics()) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema, logger: metrics });
        this.#storage = storage;
    }

    /** Where this object's Runtime keeps the Session history, once it has been settled. */
    readonly location = (): RecordingLocation | null =>
        this.#database
            .select({ location: recordingLocation.location })
            .from(recordingLocation)
            .where(eq(recordingLocation.singleton, 1))
            .all()[0]?.location ?? null;

    /** Settles where the history lives; a location settled earlier is kept and returned. */
    readonly settleLocation = (location: RecordingLocation): RecordingLocation => {
        this.#database.insert(recordingLocation).values({ singleton: 1, location }).onConflictDoNothing().run();
        return this.location() ?? location;
    };

    /** Keeps a decoded batch for later readers, evicting the least recently used ones beyond the bounds. */
    readonly #remember = (batch: RecordedBatch, characters: number): void => {
        const previous = this.#decoded.get(batch.ordinal);
        if (previous !== undefined) {
            this.#decoded.delete(batch.ordinal);
            this.#decodedCharacters -= previous.characters;
        }
        if (characters > decodedBatchCharacters) {
            return;
        }
        this.#decoded.set(batch.ordinal, { batch, characters });
        this.#decodedCharacters += characters;
        for (const [ordinal, entry] of this.#decoded) {
            if (this.#decoded.size <= decodedBatchLimit && this.#decodedCharacters <= decodedBatchCharacters) {
                break;
            }
            this.#decoded.delete(ordinal);
            this.#decodedCharacters -= entry.characters;
        }
    };

    /** Decodes one stored batch; rows written before the generation column existed carry it in their events. */
    readonly #batch = (row: {
        readonly envelopeJson: string;
        readonly ordinal: number;
        readonly sessionGenerationId: string | null;
        readonly receivedAt: number | null;
    }): RecordedBatch => {
        const cached = this.#decoded.get(row.ordinal);
        if (cached !== undefined) {
            this.#remember(cached.batch, cached.characters);
            return cached.batch;
        }
        const events = this.#decode(row);
        const batch = {
            events,
            generation: row.sessionGenerationId ?? events[0]?.sessionGenerationId ?? "",
            ordinal: row.ordinal,
            receivedAt:
                row.receivedAt ??
                Math.max(0, Math.min(Date.now(), Date.parse(events.at(-1)?.recordedAt ?? new Date().toISOString()))),
        };
        this.#remember(batch, row.envelopeJson.length);
        return batch;
    };

    readonly #batchAt = (ordinal: number): RecordedBatch | undefined => {
        const row = this.#database
            .select({
                envelopeJson: recordedSessionEvent.envelopeJson,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
                receivedAt: recordedSessionEvent.receivedAt,
            })
            .from(recordedSessionEvent)
            .where(eq(recordedSessionEvent.ordinal, ordinal))
            .all()[0];
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
                    receivedAt: recordedSessionEvent.receivedAt,
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

    readonly #tail = () =>
        this.#database
            .select({ lastPosition: recordedSessionEvent.lastPosition, ordinal: recordedSessionEvent.ordinal })
            .from(recordedSessionEvent)
            .orderBy(desc(recordedSessionEvent.ordinal))
            .limit(1)
            .all()[0];

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
     * The events of a write that this Recording does not hold yet, in write order. An event whose generation and
     * position are already recorded is a copy, such as a frame sent twice or output a reconnected daemon sends
     * again. An event that arrives after later ones is still new and is kept.
     */
    readonly #unrecorded = (events: readonly SessionWireEvent[]): readonly SessionWireEvent[] => {
        const positions = events.map((candidate) => Number(candidate.position));
        const latest = Math.max(...positions);
        const generations = new Set(events.map((candidate) => candidate.sessionGenerationId));
        const recorded = new Set<string>();
        const candidates = this.#database
            .select({
                firstPosition: recordedSessionEvent.firstPosition,
                ordinal: recordedSessionEvent.ordinal,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .where(gte(recordedSessionEvent.lastPosition, Math.min(...positions)))
            .orderBy(asc(recordedSessionEvent.lastPosition))
            .limit(copySearchBatches)
            .all();
        for (const candidate of candidates) {
            if (
                (candidate.firstPosition !== null && candidate.firstPosition > latest) ||
                (candidate.sessionGenerationId !== null && !generations.has(candidate.sessionGenerationId))
            ) {
                continue;
            }
            for (const stored of this.#batchAt(candidate.ordinal)?.events ?? []) {
                recorded.add(eventIdentity(stored));
            }
        }
        return events.filter((candidate) => {
            const identity = eventIdentity(candidate);
            if (recorded.has(identity)) {
                return false;
            }
            recorded.add(identity);
            return true;
        });
    };

    /**
     * Appends one write as one or more stored batches, leaving out events it already holds. `project` runs inside
     * the same transaction with each new batch ordinal in order, so a projection derived from a batch commits or
     * rolls back together with it. `directory` derives the Session's directory change from the events stored.
     */
    readonly append = (
        write: SessionRecordingWireWrite,
        directory: (events: readonly SessionWireEvent[]) => DirectoryChange,
        project: (ordinal: number, events: readonly SessionWireEvent[], receivedAt: number) => void = () => undefined,
    ): AppendOutcome => {
        const appended: { readonly batch: RecordedBatch; readonly characters: number }[] = [];
        const outcome = this.#storage.transactionSync((): AppendOutcome => {
            const [event, ...remainingEvents] = write.envelope.events;
            if (event === undefined || remainingEvents.some((candidate) => candidate.sessionId !== event.sessionId)) {
                return { kind: "identity_conflict" };
            }
            const metadata = this.#database
                .select()
                .from(recordingMetadata)
                .where(eq(recordingMetadata.singleton, 1))
                .all()[0];
            if (
                metadata !== undefined &&
                (metadata.projectId !== write.projectId ||
                    metadata.runtimeId !== write.runtimeId ||
                    metadata.sessionId !== event.sessionId)
            ) {
                return { kind: "identity_conflict" };
            }
            const events = this.#unrecorded(write.envelope.events);
            const copies = write.envelope.events.length - events.length;
            if (events.length === 0) {
                return { kind: "recorded", copies };
            }
            // Validated before the first write, so every committed directory change decodes when the outbox reads it.
            const change = directory(events);
            const directoryOperationsJson = JSON.stringify(directoryOperationSchema.array().parse(change.operations));
            const batches: StoredBatch[] = [];
            for (const run of addressableRuns(events)) {
                const stored = storedBatches(write.envelope, run);
                if (stored === null) {
                    return { kind: "event_too_large" };
                }
                batches.push(...stored);
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
            for (const batch of batches) {
                const [first] = batch.events;
                const last = batch.events.at(-1);
                if (first === undefined || last === undefined) {
                    throw new Error("A stored batch holds no events");
                }
                const receivedAt = Date.now();
                const inserted = this.#database
                    .insert(recordedSessionEvent)
                    .values({
                        envelopeJson: batch.encoded,
                        firstPosition: Number(first.position),
                        lastPosition: Number(last.position),
                        recordedAt: Date.parse(first.recordedAt),
                        receivedAt,
                        sessionGenerationId: first.sessionGenerationId,
                    })
                    .returning({ ordinal: recordedSessionEvent.ordinal })
                    .all()[0];
                if (inserted === undefined) {
                    throw new Error("The recorded batch did not return an append ordinal");
                }
                project(inserted.ordinal, batch.events, receivedAt);
                appended.push({
                    batch: {
                        events: batch.events,
                        generation: first.sessionGenerationId,
                        ordinal: inserted.ordinal,
                        receivedAt,
                    },
                    characters: batch.encoded.length,
                });
            }
            this.#database
                .insert(pendingDirectoryUpdate)
                .values({ operationsJson: directoryOperationsJson, events: change.events })
                .run();
            return { kind: "recorded", copies };
        });
        // Only a committed batch is kept: readers waiting on this append read it next.
        if (outcome.kind === "recorded") {
            for (const { batch, characters } of appended) {
                this.#remember(batch, characters);
            }
        }
        return outcome;
    };

    /** The Recording's owner, or null before its first batch. */
    readonly identity = (): {
        readonly projectId: string;
        readonly runtimeId: string;
        readonly sessionId: string;
    } | null => {
        const metadata = this.#database
            .select()
            .from(recordingMetadata)
            .where(eq(recordingMetadata.singleton, 1))
            .all()[0];
        return metadata === undefined
            ? null
            : { projectId: metadata.projectId, runtimeId: metadata.runtimeId, sessionId: metadata.sessionId };
    };

    /** The oldest directory changes not yet confirmed, in commit order. */
    readonly pendingDirectory = (limit: number): readonly PendingDirectoryChange[] =>
        this.#database
            .select()
            .from(pendingDirectoryUpdate)
            .orderBy(asc(pendingDirectoryUpdate.ordinal))
            .limit(limit)
            .all()
            .map((row) => ({
                ordinal: row.ordinal,
                operations: committedDirectoryOperationsSchema.parse(JSON.parse(row.operationsJson)),
                events: row.events,
            }));

    /** Forgets directory changes the directory confirmed, through `ordinal`. */
    readonly confirmDirectory = (ordinal: number): void => {
        this.#database.delete(pendingDirectoryUpdate).where(lte(pendingDirectoryUpdate.ordinal, ordinal)).run();
    };

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
            .all()[0] !== undefined;

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
    /** Reads events after an opaque append-order cursor, or from the start when `after` is null, in a bounded page. */
    readonly readPage = (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        after: string | null,
        limit: number,
    ): PageRead => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return { kind: "not_found" };
        }
        const start = after === null ? recordingStart : this.#resolveCursor(after);
        if (start === null) {
            return { kind: "cursor_expired" };
        }
        const tailCursor = this.#tailCursor();
        let selected: SelectedEvent[] = [];
        let truncated = false;
        for (const batch of this.#batchesAfterCursor(start)) {
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
        // A batch stored before positions were kept increasing per batch can repeat a position, and a cursor
        // resolves to its last copy. A page therefore ends on the last copy of its final position, so the
        // next page continues exactly where this one stopped and never skips an event between the copies.
        const end = selected.findLastIndex(isLastCopy) + 1;
        const [first] = selected;
        if (end === 0 && first !== undefined) {
            // Every listed event repeats later in its batch, so the page reads through the last copy instead.
            const lastCopy = first.batch.events.findLastIndex(
                (candidate) => Number(candidate.position) === Number(first.event.position),
            );
            selected = first.batch.events
                .slice(first.index, lastCopy + 1)
                .map((event, offset) => ({ batch: first.batch, event, index: first.index + offset }));
            truncated = lastCopy < first.batch.events.length - 1 || first.batch.ordinal < this.latestOrdinal();
        } else if (end < selected.length) {
            selected = selected.slice(0, end);
            truncated = true;
        }
        const last = selected.at(-1);
        // A caller replaces its state only when this page carries events of a generation other than the one
        // its cursor was in. The start of the Recording names no generation, so it never asks for one.
        const generationReset =
            start.generation !== "" && selected.some(({ batch }) => batch.generation !== start.generation);
        return {
            kind: "page",
            page: {
                events: selected.map(({ event }) => event),
                nextCursor: last === undefined ? null : this.#cursor(last.batch, last.index),
                sessionId,
                tailCursor,
                truncated,
                generationReset,
                version: 2,
            },
        };
    };

    /** The rest of the cursor's batch when it points inside one, then every later batch in append order. */
    *#batchesAfterCursor(cursor: ResolvedCursor): Generator<RecordedBatch> {
        if (cursor.batch !== null) {
            yield cursor.batch;
        }
        yield* this.#batchesFrom(cursor.ordinal + 1);
    }

    readonly #resolveCursor = (after: string): ResolvedCursor | null => {
        const [cursorKind, ordinalToken, positionToken] = after.split(":");
        if (cursorKind !== "v2" || ordinalToken === undefined || positionToken === undefined) {
            return null;
        }
        const ordinal = Number(ordinalToken);
        const bounds = this.#database
            .select({
                lastPosition: recordedSessionEvent.lastPosition,
                sessionGenerationId: recordedSessionEvent.sessionGenerationId,
            })
            .from(recordedSessionEvent)
            .where(eq(recordedSessionEvent.ordinal, ordinal))
            .all()[0];
        if (bounds === undefined) {
            return null;
        }
        // A tail cursor, and most page cursors, name the last event of their batch: reading resumes at the
        // next batch without decoding this one. Its last event is also the last copy of its position.
        if (bounds.lastPosition === Number(positionToken) && bounds.sessionGenerationId !== null) {
            const end = Number.POSITIVE_INFINITY;
            return { batch: null, generation: bounds.sessionGenerationId, index: end, ordinal };
        }
        const batch = this.#batchAt(ordinal);
        if (batch === undefined) {
            return null;
        }
        // A batch recorded before positions were kept increasing per batch can repeat a frame. Its cursor
        // names the last copy, so a caller never receives the repeat again; skipping a repeat loses nothing.
        const index = batch.events.findLastIndex((event) => Number(event.position) === Number(positionToken));
        return index === -1 ? null : { batch, generation: batch.generation, index, ordinal };
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
            .all()[0];
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
    readonly #decode = (row: { readonly envelopeJson: string }): readonly SessionWireEvent[] =>
        decodeSessionWireEnvelope(JSON.parse(row.envelopeJson)).events;
}
