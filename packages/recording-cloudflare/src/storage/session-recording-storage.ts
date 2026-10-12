import {
    decodeSessionEventEnvelopeV2,
    encodeSessionEventEnvelopeV2,
    type SessionEventV2,
    type SessionRecordingHistory,
    type SessionRecordingHistoryPage,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, asc, eq, gt, isNotNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import { recordedSessionEvent, recordingMetadata } from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

export class SessionRecordingStorage {
    readonly #database;
    readonly #storage: DurableObjectStorage;
    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
    }
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
                    lastPosition: finalEvent === undefined ? Number(event.position) : Number(finalEvent.position),
                    recordedAt: Date.parse(event.recordedAt),
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
    }; /**
     * Reads the events after a position cursor in a bounded page. Batches end at their highest
     * position, so the seek skips every batch that finished at or before the cursor and only the
     * boundary batch is decoded to drop its already-delivered prefix.
     */
    readonly readPage = (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        after: number,
        limit: number,
    ): SessionRecordingHistoryPage | null => {
        const metadata = this.#metadata(projectId, runtimeId, sessionId);
        if (metadata === undefined) {
            return null;
        }
        const tail = this.#database
            .select({ value: max(recordedSessionEvent.lastPosition) })
            .from(recordedSessionEvent)
            .where(isNotNull(recordedSessionEvent.lastPosition))
            .get();
        const tailCursor = tail?.value;
        const events: SessionEventV2[] = [];
        const delivered = new Set<string>();
        let truncated = false;
        if (tailCursor !== undefined && tailCursor !== null && tailCursor > after) {
            const rows = this.#database
                .select({ envelopeJson: recordedSessionEvent.envelopeJson })
                .from(recordedSessionEvent)
                .where(and(gt(recordedSessionEvent.lastPosition, after), isNotNull(recordedSessionEvent.lastPosition)))
                .orderBy(asc(recordedSessionEvent.ordinal))
                .all();
            for (const row of rows) {
                const remaining = limit - events.length;
                if (remaining <= 0) {
                    truncated = true;
                    break;
                }
                const batch = this.#decode({ envelopeJson: row.envelopeJson });
                const fresh = batch.filter((event) => {
                    if (Number(event.position) <= after || delivered.has(event.eventId)) {
                        return false;
                    }
                    delivered.add(event.eventId);
                    return true;
                });
                if (fresh.length > remaining) {
                    events.push(...fresh.slice(0, remaining));
                    truncated = true;
                    break;
                }
                events.push(...fresh);
            }
        }
        const last = events.at(-1);
        return {
            events,
            nextCursor: last === undefined ? null : last.position,
            sessionId,
            tailCursor: tailCursor === undefined || tailCursor === null ? String(after) : String(tailCursor),
            truncated,
            version: 2,
        };
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
