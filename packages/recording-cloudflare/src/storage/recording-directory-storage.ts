import {
    isIdentifier,
    type SessionRecordingDelivery,
    type SessionRecordingIntegrity,
    type SessionRecordingRetention,
    type SessionRecordingSummary,
    type SessionRecordingTarget,
} from "@moxt-ai/mobius-protocol";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { recordingDirectoryDurableObjectMigrations } from "../generated/recording-directory-do-migrations.ts";
import * as schema from "../schema/recording-directory-do/index.ts";
import { recordingSessionIndex, recordingSessionSummary } from "../schema/recording-directory-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export interface RecordingDirectoryQuery {
    readonly cursor: string | null;
    readonly limit: number;
    readonly query: string;
    readonly status: "running" | "idle" | "failed" | null;
}

export interface RecordingDirectoryPage {
    readonly nextCursor?: string;
    readonly sessions: readonly SessionRecordingSummary[];
    readonly truncated?: boolean;
}

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
    readonly save = (summary: SessionRecordingSummary, projectId: string, runtimeId: string): void => {
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
        const now = Date.parse(summary.updatedAt);
        this.#database
            .insert(recordingSessionIndex)
            .values({
                sessionId: summary.sessionId,
                projectId,
                runtimeId,
                createdAt: now,
                updatedAt: now,
                firstDeliveredAt: now,
                lastDeliveredAt: now,
                recordedEventCount: 0,
                expectedEventCount: 0,
                missingEventCount: 0,
            })
            .onConflictDoUpdate({
                target: recordingSessionIndex.sessionId,
                set: {
                    projectId,
                    runtimeId,
                    updatedAt: now,
                    lastDeliveredAt: now,
                },
            })
            .run();
    };
    readonly findTarget = (sessionId: string): SessionRecordingTarget | null => {
        const index = this.#database
            .select()
            .from(recordingSessionIndex)
            .where(eq(recordingSessionIndex.sessionId, sessionId))
            .get();
        return index === undefined ? null : { projectId: index.projectId, runtimeId: index.runtimeId, sessionId };
    };
    readonly findSummary = (sessionId: string): SessionRecordingSummary | null => {
        const row = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .get();
        return row === undefined ? null : decodeSummary(row);
    };
    readonly read = (
        runtimeId: string,
        query: RecordingDirectoryQuery = { cursor: null, limit: DEFAULT_PAGE_SIZE, query: "", status: null },
    ): RecordingDirectoryPage => {
        const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, query.limit));
        const decodedCursor = decodeCursor(query.cursor);
        const filter = and(
            eq(recordingSessionIndex.runtimeId, runtimeId),
            query.status === null ? undefined : eq(recordingSessionSummary.status, query.status),
            query.query.length === 0
                ? undefined
                : or(
                      sql`lower(${recordingSessionSummary.title}) like lower(${`%${query.query}%`})`,
                      sql`lower(${recordingSessionSummary.sessionId}) like lower(${`%${query.query}%`})`,
                  ),
            decodedCursor === null
                ? undefined
                : or(
                      lt(recordingSessionSummary.updatedAt, decodedCursor.updatedAt),
                      and(
                          eq(recordingSessionSummary.updatedAt, decodedCursor.updatedAt),
                          lt(recordingSessionSummary.sessionId, decodedCursor.sessionId),
                      ),
                  ),
        );
        const rows = this.#database
            .select()
            .from(recordingSessionSummary)
            .innerJoin(recordingSessionIndex, eq(recordingSessionSummary.sessionId, recordingSessionIndex.sessionId))
            .where(filter)
            .orderBy(desc(recordingSessionSummary.updatedAt), desc(recordingSessionSummary.sessionId))
            .limit(limit + 1)
            .all();
        const sessions = rows.slice(0, limit).map((row) => decodeSummary(row.recording_session_summaries));
        const last = sessions.at(-1);
        const nextCursor =
            rows.length > limit && last !== undefined ? encodeCursor(last.updatedAt, last.sessionId) : null;
        return {
            sessions,
            ...(nextCursor === null ? {} : { nextCursor }),
            ...(rows.length > limit ? { truncated: true } : {}),
        };
    };
    readonly updateDelivery = (
        sessionId: string,
        delivery: SessionRecordingDelivery,
        integrity: SessionRecordingIntegrity,
        retention: SessionRecordingRetention,
    ): void => {
        if (delivery.kind !== "recorded") {
            return;
        }
        const existing = this.#database
            .select()
            .from(recordingSessionIndex)
            .where(eq(recordingSessionIndex.sessionId, sessionId))
            .get();
        const firstDeliveredAt = Math.min(
            existing?.firstDeliveredAt ?? Date.parse(delivery.firstDeliveredAt),
            Date.parse(delivery.firstDeliveredAt),
        );
        const lastDeliveredAt = Math.max(
            existing?.lastDeliveredAt ?? Date.parse(delivery.lastDeliveredAt),
            Date.parse(delivery.lastDeliveredAt),
        );
        const values = {
            updatedAt: lastDeliveredAt,
            firstDeliveredAt,
            lastDeliveredAt,
            recordedEventCount: delivery.recordedEventCount,
            expectedEventCount: integrity.expectedEventCount,
            missingEventCount: delivery.missingEventCount,
            retentionMilliseconds: retention.kind === "managed" ? retention.retentionMilliseconds : null,
            expiresAt: retention.kind === "managed" ? lastDeliveredAt + retention.retentionMilliseconds : null,
        };
        if (existing === undefined) {
            throw new Error("The Recording Session index is missing");
        }
        this.#database
            .update(recordingSessionIndex)
            .set(values)
            .where(eq(recordingSessionIndex.sessionId, sessionId))
            .run();
    };
    readonly upsertIndex = (
        target: SessionRecordingTarget,
        delivery: SessionRecordingDelivery,
        integrity: SessionRecordingIntegrity,
        retention: SessionRecordingRetention,
    ): void => {
        if (delivery.kind !== "recorded") {
            return;
        }
        const firstDeliveredAt = Date.parse(delivery.firstDeliveredAt);
        const lastDeliveredAt = Date.parse(delivery.lastDeliveredAt);
        this.#database
            .insert(recordingSessionIndex)
            .values({
                sessionId: target.sessionId,
                projectId: target.projectId,
                runtimeId: target.runtimeId,
                createdAt: firstDeliveredAt,
                updatedAt: lastDeliveredAt,
                firstDeliveredAt,
                lastDeliveredAt,
                recordedEventCount: delivery.recordedEventCount,
                expectedEventCount: integrity.expectedEventCount,
                missingEventCount: delivery.missingEventCount,
                retentionMilliseconds: retention.kind === "managed" ? retention.retentionMilliseconds : null,
                expiresAt: retention.kind === "managed" ? lastDeliveredAt + retention.retentionMilliseconds : null,
            })
            .onConflictDoUpdate({
                target: recordingSessionIndex.sessionId,
                set: {
                    projectId: target.projectId,
                    runtimeId: target.runtimeId,
                    updatedAt: lastDeliveredAt,
                    firstDeliveredAt,
                    lastDeliveredAt,
                    recordedEventCount: delivery.recordedEventCount,
                    expectedEventCount: integrity.expectedEventCount,
                    missingEventCount: delivery.missingEventCount,
                    retentionMilliseconds: retention.kind === "managed" ? retention.retentionMilliseconds : null,
                    expiresAt: retention.kind === "managed" ? lastDeliveredAt + retention.retentionMilliseconds : null,
                },
            })
            .run();
    };
    readonly delete = (sessionId: string): boolean => {
        const summary = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .get();
        const index = this.#database
            .select()
            .from(recordingSessionIndex)
            .where(eq(recordingSessionIndex.sessionId, sessionId))
            .get();
        if (summary === undefined && index === undefined) {
            return false;
        }
        this.#database.delete(recordingSessionSummary).where(eq(recordingSessionSummary.sessionId, sessionId)).run();
        this.#database.delete(recordingSessionIndex).where(eq(recordingSessionIndex.sessionId, sessionId)).run();
        return true;
    };
}

function encodeCursor(updatedAt: string, sessionId: string): string {
    return btoa(JSON.stringify({ updatedAt, sessionId })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(cursor: string | null): { readonly updatedAt: number; readonly sessionId: string } | null {
    if (cursor === null) {
        return null;
    }
    try {
        const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
        const value: unknown = JSON.parse(atob(normalized));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const updatedAt = Reflect.get(value, "updatedAt");
        const sessionId = Reflect.get(value, "sessionId");
        return typeof updatedAt === "string" && isIdentifier(sessionId) && Number.isSafeInteger(Date.parse(updatedAt))
            ? { updatedAt: Date.parse(updatedAt), sessionId }
            : null;
    } catch {
        return null;
    }
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
