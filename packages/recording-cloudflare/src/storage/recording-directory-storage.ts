import {
    isIdentifier,
    type SessionRecordingDirectory,
    type SessionRecordingSummary,
} from "@moxt-ai/mobius-sdk/protocol";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { recordingDirectoryDurableObjectMigrations } from "../generated/recording-directory-do-migrations.ts";
import * as schema from "../schema/recording-directory-do/index.ts";
import { recordingSessionSummary } from "../schema/recording-directory-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

export class RecordingDirectoryStorage {
    readonly #database;
    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, recordingDirectoryDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
    }
    readonly find = (sessionId: string): SessionRecordingSummary | null => {
        const row = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .get();
        return row === undefined ? null : decodeSummary(row);
    };
    readonly save = (summary: SessionRecordingSummary): void => {
        const values = {
            sessionId: summary.sessionId,
            runtimeId: summary.runtimeId,
            agentId: summary.agentId,
            directoryId: summary.directoryId,
            additionalDirectoryIdsJson: JSON.stringify(summary.additionalDirectoryIds),
            title: summary.title,
            status: summary.status,
            prompted: true,
            updatedAt: Date.parse(summary.updatedAt),
        };
        this.#database
            .insert(recordingSessionSummary)
            .values(values)
            .onConflictDoUpdate({ target: recordingSessionSummary.sessionId, set: values })
            .run();
    };
    readonly read = (runtimeId: string): SessionRecordingDirectory => ({
        sessions: this.#database
            .select()
            .from(recordingSessionSummary)
            .where(and(eq(recordingSessionSummary.runtimeId, runtimeId), eq(recordingSessionSummary.prompted, true)))
            .orderBy(desc(recordingSessionSummary.updatedAt), desc(recordingSessionSummary.sessionId))
            .all()
            .map(decodeSummary),
    });
}
function decodeSummary(row: typeof recordingSessionSummary.$inferSelect): SessionRecordingSummary {
    const directories: unknown = JSON.parse(row.additionalDirectoryIdsJson);
    if (!Array.isArray(directories) || !directories.every(isIdentifier)) {
        throw new Error("Invalid recorded directory identifiers");
    }
    return {
        additionalDirectoryIds: directories,
        agentId: row.agentId,
        directoryId: row.directoryId,
        runtimeId: row.runtimeId,
        sessionId: row.sessionId,
        status: row.status,
        title: row.title,
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}
