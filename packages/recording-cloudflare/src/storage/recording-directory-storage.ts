import {
    conversationTitleFromText,
    decodeRecordedSessionEvent,
    isIdentifier,
    type SessionRecordingDirectory,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { and, desc, eq } from "drizzle-orm";
import { type DrizzleSqliteDODatabase, drizzle } from "drizzle-orm/durable-sqlite";
import { recordingDirectoryDurableObjectMigrations } from "../generated/recording-directory-do-migrations.ts";
import * as schema from "../schema/recording-directory-do/index.ts";
import { recordingSessionSummary } from "../schema/recording-directory-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

type RecordingDirectoryDatabase = DrizzleSqliteDODatabase<typeof schema>;

function decodeAdditionalDirectoryIds(encoded: string): readonly string[] {
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value) || !value.every((entry): entry is string => isIdentifier(entry))) {
        throw new Error("Recording stored invalid additional directory identifiers");
    }
    return value;
}

export class RecordingDirectoryStorage {
    readonly #database: RecordingDirectoryDatabase;
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, recordingDirectoryDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
    }

    readonly record = (write: SessionRecordingWrite, recordedAt: number): void => {
        const event = decodeRecordedSessionEvent(write.envelope.payload);
        this.#storage.transactionSync(() => {
            const existing = this.#database
                .select()
                .from(recordingSessionSummary)
                .where(eq(recordingSessionSummary.sessionId, write.envelope.sessionId))
                .get();
            if (event.kind === "session.ready") {
                const values = {
                    additionalDirectoryIdsJson: JSON.stringify(
                        event.additionalDirectories.map((directory) => directory.directoryId),
                    ),
                    agentId: event.agentId,
                    directoryId: event.directoryId,
                    runtimeId: write.runtimeId,
                    sessionId: write.envelope.sessionId,
                    prompted: existing?.prompted ?? false,
                    title: existing?.title ?? "",
                    updatedAt: Math.max(existing?.updatedAt ?? 0, recordedAt),
                };
                this.#database
                    .insert(recordingSessionSummary)
                    .values(values)
                    .onConflictDoUpdate({
                        set: values,
                        target: recordingSessionSummary.sessionId,
                    })
                    .run();
                return;
            }
            if (existing === undefined) {
                return;
            }
            this.#database
                .update(recordingSessionSummary)
                .set({
                    prompted: event.kind === "session.started" || existing.prompted,
                    title:
                        event.kind === "session.started" && existing.title.length === 0
                            ? conversationTitleFromText(event.prompt)
                            : existing.title,
                    updatedAt: Math.max(existing.updatedAt, recordedAt),
                })
                .where(eq(recordingSessionSummary.sessionId, write.envelope.sessionId))
                .run();
        });
    };

    readonly read = (runtimeId: string): SessionRecordingDirectory => ({
        sessions: this.#database
            .select()
            .from(recordingSessionSummary)
            .where(and(eq(recordingSessionSummary.runtimeId, runtimeId), eq(recordingSessionSummary.prompted, true)))
            .orderBy(desc(recordingSessionSummary.updatedAt), desc(recordingSessionSummary.sessionId))
            .all()
            .map((row) => ({
                additionalDirectoryIds: decodeAdditionalDirectoryIds(row.additionalDirectoryIdsJson),
                agentId: row.agentId,
                directoryId: row.directoryId,
                runtimeId: row.runtimeId,
                sessionId: row.sessionId,
                title: row.title,
                updatedAt: new Date(row.updatedAt).toISOString(),
            })),
    });
}
