import {
    isDirectoryIdentifier,
    type SessionRecordingDirectoryV2,
    type SessionRecordingSummaryV2,
} from "@moxt-ai/mobius-sdk/protocol";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { recordingDirectoryDurableObjectMigrations } from "../generated/recording-directory-do-migrations.ts";
import { RecordingSqlMetrics } from "../infra/recording-sql-metrics.ts";
import * as schema from "../schema/recording-directory-do/index.ts";
import { recordingSessionSummary } from "../schema/recording-directory-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

export class RecordingDirectoryStorage {
    readonly #database;
    constructor(storage: DurableObjectStorage, metrics: RecordingSqlMetrics = new RecordingSqlMetrics()) {
        applyDurableObjectMigrations(storage, recordingDirectoryDurableObjectMigrations);
        this.#database = drizzle(storage, { schema, logger: metrics });
    }
    readonly find = (sessionId: string): SessionRecordingSummaryV2 | null => {
        const row = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .all()[0];
        return row === undefined ? null : decodeSummary(row);
    };
    readonly save = (summary: SessionRecordingSummaryV2): void => {
        const values = {
            sessionId: summary.sessionId,
            runtimeId: summary.runtimeId,
            agentId: summary.agentId,
            directoryId: summary.directoryId,
            additionalDirectoryIdsJson: JSON.stringify(summary.additionalDirectoryIds),
            title: summary.title,
            prompted: true,
            updatedAt: Date.parse(summary.updatedAt),
        };
        this.#database
            .insert(recordingSessionSummary)
            .values(values)
            .onConflictDoUpdate({ target: recordingSessionSummary.sessionId, set: values })
            .run();
    };
    readonly read = (runtimeId: string): SessionRecordingDirectoryV2 => ({
        sessions: this.#database
            .select()
            .from(recordingSessionSummary)
            .where(and(eq(recordingSessionSummary.runtimeId, runtimeId), eq(recordingSessionSummary.prompted, true)))
            .orderBy(desc(recordingSessionSummary.updatedAt), desc(recordingSessionSummary.sessionId))
            .all()
            .map(decodeSummary),
    });
}
function decodeSummary(row: typeof recordingSessionSummary.$inferSelect): SessionRecordingSummaryV2 {
    const directories: unknown = JSON.parse(row.additionalDirectoryIdsJson);
    if (!Array.isArray(directories) || !directories.every(isDirectoryIdentifier)) {
        throw new Error("Invalid recorded directory identifiers");
    }
    return {
        additionalDirectoryIds: directories,
        agentId: row.agentId,
        directoryId: row.directoryId,
        runtimeId: row.runtimeId,
        sessionId: row.sessionId,
        title: row.title,
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}
