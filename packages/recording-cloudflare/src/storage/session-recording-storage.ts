import {
    decodeSessionEventEnvelope,
    encodeSessionEventEnvelope,
    type SessionRecordingEntry,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { asc, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

type RecordingDatabase = DrizzleSqliteDODatabase<typeof schema>;

export type SessionRecordingClaim =
    | { readonly kind: "accepted"; readonly recordedAt: number; readonly recordingEpoch: string }
    | { readonly kind: "duplicate"; readonly recordedAt: number; readonly recordingEpoch: string }
    | { readonly kind: "conflict" };

export interface StoredSessionRecordingHistory {
    readonly entries: readonly SessionRecordingEntry[];
    readonly recordingEpoch: string;
}

export class SessionRecordingStorage {
    readonly #database: RecordingDatabase;
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
    }

    readonly claim = (write: SessionRecordingWrite, now: number): SessionRecordingClaim =>
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
        return { entries, recordingEpoch: metadata.recordingEpoch };
    };
}
