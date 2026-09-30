import {
    decodeRecordedSessionEvent,
    decodeSessionEventEnvelope,
    encodeSessionEventEnvelope,
    type RecordedSessionEvent,
    type SessionRecordingEntry,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, asc, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import {
    recordedSessionEvent,
    recordedTurn,
    recordingForkOrigin,
    recordingMetadata,
} from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

type RecordingDatabase = DrizzleSqliteDODatabase<typeof schema>;

export type SessionRecordingClaim =
    | { readonly kind: "accepted"; readonly recordedAt: number; readonly recordingEpoch: string }
    | { readonly kind: "duplicate"; readonly recordedAt: number; readonly recordingEpoch: string }
    | { readonly kind: "conflict" };

export interface StoredSessionRecordingHistory {
    readonly entries: readonly SessionRecordingEntry[];
    readonly origin: StoredRecordingForkOrigin | null;
    readonly recordingEpoch: string;
}

export interface StoredRecordingForkOrigin {
    readonly sourceRecordingEpoch: string;
    readonly sourceSessionId: string;
    readonly throughCommandId: string;
}

export interface RecordingForkOriginInput extends StoredRecordingForkOrigin {
    readonly createdAt: number;
}

export class SessionRecordingStorage {
    readonly #database: RecordingDatabase;
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
        this.#backfillTurnProjection();
    }

    readonly #backfillTurnProjection = (): void => {
        const metadata = this.#database
            .select({ projectionVersion: recordingMetadata.projectionVersion })
            .from(recordingMetadata)
            .where(eq(recordingMetadata.singleton, 1))
            .get();
        if (metadata === undefined || metadata.projectionVersion >= 1) {
            return;
        }
        this.#storage.transactionSync(() => {
            const events = this.#database
                .select({
                    envelopeJson: recordedSessionEvent.envelopeJson,
                    ordinal: recordedSessionEvent.ordinal,
                    recordedAt: recordedSessionEvent.recordedAt,
                })
                .from(recordedSessionEvent)
                .orderBy(asc(recordedSessionEvent.ordinal))
                .all();
            for (const stored of events) {
                const envelope = decodeSessionEventEnvelope(stored.envelopeJson);
                if (!("delivery" in envelope)) {
                    continue;
                }
                const event = decodeRecordedSessionEvent(envelope.payload);
                if (event.kind === "session.started") {
                    this.#database
                        .insert(recordedTurn)
                        .values({
                            attemptId: event.attemptId,
                            commandId: event.commandId,
                            createdAt: stored.recordedAt,
                            startedOrdinal: stored.ordinal,
                            state: "running",
                        })
                        .onConflictDoNothing()
                        .run();
                } else if (event.kind === "session.completed" || event.kind === "session.failed") {
                    this.#database
                        .update(recordedTurn)
                        .set({
                            settledAt: stored.recordedAt,
                            state: event.kind === "session.completed" ? "completed" : "failed",
                            terminalOrdinal: stored.ordinal,
                        })
                        .where(and(eq(recordedTurn.commandId, event.commandId), eq(recordedTurn.state, "running")))
                        .run();
                }
            }
            this.#database
                .update(recordingMetadata)
                .set({ projectionVersion: 1 })
                .where(eq(recordingMetadata.singleton, 1))
                .run();
        });
    };

    readonly claim = (
        write: SessionRecordingWrite,
        event: RecordedSessionEvent,
        now: number,
        forkOrigin: RecordingForkOriginInput | null = null,
    ): SessionRecordingClaim =>
        this.#storage.transactionSync(() => {
            const metadata = this.#database
                .select()
                .from(recordingMetadata)
                .where(eq(recordingMetadata.singleton, 1))
                .get();
            let recordingEpoch: string;
            if (metadata === undefined) {
                recordingEpoch = `rec_${crypto.randomUUID()}`;
                this.#database
                    .insert(recordingMetadata)
                    .values({
                        createdAt: now,
                        projectId: write.projectId,
                        recordingEpoch,
                        runtimeId: write.runtimeId,
                        sessionId: write.envelope.sessionId,
                        singleton: 1,
                        projectionVersion: 1,
                    })
                    .run();
            } else {
                if (
                    metadata.projectId !== write.projectId ||
                    metadata.runtimeId !== write.runtimeId ||
                    metadata.sessionId !== write.envelope.sessionId
                ) {
                    return { kind: "conflict" };
                }
                recordingEpoch = metadata.recordingEpoch;
            }

            const envelopeJson = encodeSessionEventEnvelope(write.envelope);
            const existing = this.#database
                .select({
                    envelopeJson: recordedSessionEvent.envelopeJson,
                    recordedAt: recordedSessionEvent.recordedAt,
                })
                .from(recordedSessionEvent)
                .where(eq(recordedSessionEvent.eventId, write.envelope.delivery.eventId))
                .get();
            if (existing !== undefined) {
                return existing.envelopeJson === envelopeJson
                    ? { kind: "duplicate", recordedAt: existing.recordedAt, recordingEpoch }
                    : { kind: "conflict" };
            }
            const commandId = "commandId" in event ? event.commandId : null;
            const existingTurn =
                commandId === null
                    ? undefined
                    : this.#database.select().from(recordedTurn).where(eq(recordedTurn.commandId, commandId)).get();
            if (event.kind === "session.started" && existingTurn !== undefined) {
                return { kind: "conflict" };
            }
            if (
                commandId !== null &&
                event.kind !== "session.started" &&
                event.kind !== "session.forked" &&
                existingTurn?.state !== "running"
            ) {
                return { kind: "conflict" };
            }
            if (
                (event.kind === "session.completed" || event.kind === "session.failed") &&
                existingTurn?.state !== "running"
            ) {
                return { kind: "conflict" };
            }
            if (event.kind === "session.forked") {
                if (
                    forkOrigin === null ||
                    forkOrigin.sourceSessionId !== event.sourceSessionId ||
                    forkOrigin.throughCommandId !== event.throughCommandId ||
                    this.#database.select().from(recordedTurn).limit(1).get() !== undefined ||
                    this.#database
                        .select()
                        .from(recordingForkOrigin)
                        .where(eq(recordingForkOrigin.singleton, 1))
                        .get() !== undefined
                ) {
                    return { kind: "conflict" };
                }
            }
            this.#database
                .insert(recordedSessionEvent)
                .values({
                    envelopeJson,
                    eventId: write.envelope.delivery.eventId,
                    recordedAt: now,
                    sourceSeq: write.envelope.delivery.sourceSeq,
                    streamId: write.envelope.delivery.streamId,
                })
                .run();
            const storedEvent = this.#database
                .select({ ordinal: recordedSessionEvent.ordinal })
                .from(recordedSessionEvent)
                .where(eq(recordedSessionEvent.eventId, write.envelope.delivery.eventId))
                .get();
            if (storedEvent === undefined) {
                throw new Error("Recording did not persist the accepted event");
            }
            if (event.kind === "session.started") {
                this.#database
                    .insert(recordedTurn)
                    .values({
                        attemptId: event.attemptId,
                        commandId: event.commandId,
                        createdAt: now,
                        startedOrdinal: storedEvent.ordinal,
                        state: "running",
                    })
                    .run();
            } else if (event.kind === "session.completed" || event.kind === "session.failed") {
                this.#database
                    .update(recordedTurn)
                    .set({
                        settledAt: now,
                        state: event.kind === "session.completed" ? "completed" : "failed",
                        terminalOrdinal: storedEvent.ordinal,
                    })
                    .where(eq(recordedTurn.commandId, event.commandId))
                    .run();
            } else if (event.kind === "session.forked" && forkOrigin !== null) {
                this.#database
                    .insert(recordingForkOrigin)
                    .values({
                        createdAt: forkOrigin.createdAt,
                        singleton: 1,
                        sourceRecordingEpoch: forkOrigin.sourceRecordingEpoch,
                        sourceSessionId: forkOrigin.sourceSessionId,
                        throughCommandId: forkOrigin.throughCommandId,
                    })
                    .run();
            }
            return { kind: "accepted", recordedAt: now, recordingEpoch };
        });

    readonly read = (projectId: string, runtimeId: string, sessionId: string): StoredSessionRecordingHistory | null => {
        const metadata = this.#database
            .select()
            .from(recordingMetadata)
            .where(eq(recordingMetadata.singleton, 1))
            .get();
        if (metadata === undefined) {
            return null;
        }
        if (metadata.projectId !== projectId || metadata.runtimeId !== runtimeId || metadata.sessionId !== sessionId) {
            return null;
        }
        const entries = this.#database
            .select({
                envelopeJson: recordedSessionEvent.envelopeJson,
                recordedAt: recordedSessionEvent.recordedAt,
            })
            .from(recordedSessionEvent)
            .orderBy(asc(recordedSessionEvent.ordinal))
            .all()
            .map((row) => ({
                envelope: decodeSessionEventEnvelope(row.envelopeJson),
                recordedAt: new Date(row.recordedAt).toISOString(),
            }))
            .filter((entry): entry is SessionRecordingEntry => "delivery" in entry.envelope);
        const origin = this.#database
            .select()
            .from(recordingForkOrigin)
            .where(eq(recordingForkOrigin.singleton, 1))
            .get();
        return {
            entries,
            origin:
                origin === undefined
                    ? null
                    : {
                          sourceRecordingEpoch: origin.sourceRecordingEpoch,
                          sourceSessionId: origin.sourceSessionId,
                          throughCommandId: origin.throughCommandId,
                      },
            recordingEpoch: metadata.recordingEpoch,
        };
    };
}
