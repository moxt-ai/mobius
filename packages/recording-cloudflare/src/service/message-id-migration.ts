import {
    decodeSessionEventEnvelope,
    type SessionLiveEvent,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import {
    type LegacyMessageGroup,
    MessageIdMigrationError,
    type MessageIdMigrationProgress,
} from "../entity/message-id-migration.ts";
import type { MessageIdMigrationStorage } from "../storage/message-id-migration-storage.ts";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";
import type { SessionTurnHistoryStorage } from "../storage/session-turn-history-storage.ts";

// Parse without stripping unknown fields: only the intended payload key may change.
const rawEnvelopeSchema = z.object({ events: z.array(z.record(z.string(), z.unknown())) }).passthrough();
const rawPayloadSchema = z.record(z.string(), z.unknown());

function isMissingMessage(event: SessionLiveEvent): boolean {
    if (event.type !== "acp") {
        return false;
    }
    switch (event.payload.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
        case "agent_thought_chunk":
            return event.payload.messageId === undefined || event.payload.messageId === null;
        default:
            return false;
    }
}

export class MessageIdMigration {
    readonly storage: MessageIdMigrationStorage;
    readonly recording: SessionRecordingStorage;
    readonly history: SessionTurnHistoryStorage;
    constructor(
        storage: MessageIdMigrationStorage,
        recording: SessionRecordingStorage,
        history: SessionTurnHistoryStorage,
    ) {
        this.storage = storage;
        this.recording = recording;
        this.history = history;
    }

    readonly running = (): boolean => this.storage.progress()?.kind === "running";

    readonly preview = (afterOrdinal: number) => {
        let throughOrdinal = afterOrdinal;
        let missingEvents = 0;
        let affectedBatches = 0;
        for (const row of this.storage.batches(afterOrdinal)) {
            const events = decodeSessionEventEnvelope(row.envelopeJson).events;
            const missing = events.filter(isMissingMessage).length;
            missingEvents += missing;
            affectedBatches += missing > 0 ? 1 : 0;
            throughOrdinal = row.ordinal;
        }
        return {
            kind: "dry-run",
            throughOrdinal,
            tailOrdinal: this.recording.latestOrdinal(),
            missingEvents,
            affectedBatches,
            hasMore: throughOrdinal < this.recording.latestOrdinal(),
        };
    };

    readonly advance = (): MessageIdMigrationProgress => {
        try {
            return this.storage.transaction(() => {
                const previous = this.storage.progress();
                let progress: MessageIdMigrationProgress = previous ?? {
                    kind: "running",
                    throughOrdinal: 0,
                    rewrittenEvents: 0,
                    rewrittenBatches: 0,
                    group: { kind: "none" },
                };
                if (progress.kind === "complete") {
                    return progress;
                }
                for (const row of this.storage.batches(progress.throughOrdinal)) {
                    const original = decodeSessionEventEnvelope(row.envelopeJson).events;
                    const normalized = this.#normalize(original, progress.group);
                    if (normalized.changed > 0) {
                        const value: unknown = JSON.parse(row.envelopeJson);
                        const raw = rawEnvelopeSchema.parse(value);
                        const events = raw.events.map((event, index) => {
                            const next = normalized.events[index];
                            if (
                                next === undefined ||
                                !isMissingMessage(original[index] ?? next) ||
                                next.type !== "acp" ||
                                !("messageId" in next.payload)
                            ) {
                                return event;
                            }
                            return {
                                ...event,
                                payload: {
                                    ...rawPayloadSchema.parse(event["payload"]),
                                    messageId: next.payload.messageId,
                                },
                            };
                        });
                        this.storage.rewrite(row.ordinal, JSON.stringify({ ...raw, events }));
                        // Clear all deduplication and derived grouping state in the same transaction.
                        if (progress.rewrittenEvents === 0) {
                            this.history.resetProjection();
                        }
                    }
                    progress = {
                        ...progress,
                        throughOrdinal: row.ordinal,
                        group: normalized.group,
                        rewrittenEvents: progress.rewrittenEvents + normalized.changed,
                        rewrittenBatches: progress.rewrittenBatches + (normalized.changed > 0 ? 1 : 0),
                    };
                }
                const result: MessageIdMigrationProgress = {
                    ...progress,
                    kind: progress.throughOrdinal >= this.recording.latestOrdinal() ? "complete" : "running",
                };
                this.storage.save(result);
                return result;
            });
        } catch (cause) {
            throw new MessageIdMigrationError(cause);
        }
    };

    // Once a Session is migrated, old daemon writes must not reintroduce unidentified chunks.
    readonly append = (
        write: SessionRecordingWrite,
        project: (ordinal: number, events: readonly SessionLiveEvent[]) => void,
    ): boolean =>
        this.storage.transaction(() => {
            const progress = this.storage.progress();
            if (progress?.kind !== "complete") {
                return this.recording.append(write, project);
            }
            const first = write.envelope.events[0];
            if (
                first === undefined ||
                !this.recording.records(write.projectId, write.runtimeId, first.sessionId) ||
                write.envelope.events.some((event) => event.sessionId !== first.sessionId)
            ) {
                return false;
            }
            const normalized = this.#normalize(write.envelope.events, progress.group);
            return this.recording.append(
                { ...write, envelope: { ...write.envelope, events: normalized.events } },
                (ordinal, events) => {
                    this.storage.save({ ...progress, throughOrdinal: ordinal, group: normalized.group });
                    project(ordinal, events);
                },
            );
        });

    #normalize(events: readonly SessionLiveEvent[], initial: LegacyMessageGroup) {
        let group = initial;
        let changed = 0;
        const result = events.map((event): SessionLiveEvent => {
            if (event.type !== "acp") {
                group = { kind: "none" };
                return event;
            }
            const payload = event.payload;
            switch (payload.sessionUpdate) {
                case "user_message_chunk":
                case "agent_message_chunk":
                case "agent_thought_chunk": {
                    if (payload.messageId !== null && payload.messageId !== undefined) {
                        group = { kind: "none" };
                        return event;
                    }
                    changed++;
                    const existing = this.storage.identity(event.sessionGenerationId, event.eventId);
                    if (existing !== undefined) {
                        return { ...event, payload: { ...payload, messageId: existing } };
                    }
                    const messageId =
                        group.kind === "legacy" &&
                        group.chunkKind === payload.sessionUpdate &&
                        group.generationId === event.sessionGenerationId
                            ? group.messageId
                            : `recording-legacy:${JSON.stringify([event.sessionId, event.sessionGenerationId, payload.sessionUpdate, event.eventId])}`;
                    this.storage.identify(event.sessionGenerationId, event.eventId, messageId);
                    group = {
                        kind: "legacy",
                        chunkKind: payload.sessionUpdate,
                        generationId: event.sessionGenerationId,
                        messageId,
                    };
                    return { ...event, payload: { ...payload, messageId } };
                }
                default:
                    group = { kind: "none" };
                    return event;
            }
        });
        return { events: result, group, changed };
    }
}
