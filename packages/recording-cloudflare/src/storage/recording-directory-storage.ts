import { isIdentifier, type SessionRecordingSummary, type SessionRecordingTarget } from "@moxt-ai/mobius-protocol";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { recordingDirectoryDurableObjectMigrations } from "../generated/recording-directory-do-migrations.ts";
import * as schema from "../schema/recording-directory-do/index.ts";
import { recordingSessionSummary } from "../schema/recording-directory-do/index.ts";
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
    readonly save = (summary: SessionRecordingSummary, prompted = true): void => {
        const values = {
            sessionId: summary.sessionId,
            projectId: summary.projectId,
            runtimeId: summary.runtimeId,
            agentId: summary.agentId,
            directoryId: summary.directoryId,
            additionalDirectoryIdsJson: JSON.stringify(summary.additionalDirectoryIds),
            title: summary.title,
            status: summary.status,
            prompted,
            updatedAt: Date.parse(summary.updatedAt),
        };
        this.#database
            .insert(recordingSessionSummary)
            .values(values)
            .onConflictDoUpdate({ target: recordingSessionSummary.sessionId, set: values })
            .run();
    };
    readonly findTarget = (sessionId: string): SessionRecordingTarget | null => {
        const row = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .get();
        return row === undefined || row.projectId === null
            ? null
            : { projectId: row.projectId, runtimeId: row.runtimeId, sessionId };
    };
    readonly findSummary = (sessionId: string): SessionRecordingSummary | null => {
        const row = this.#database
            .select()
            .from(recordingSessionSummary)
            .where(eq(recordingSessionSummary.sessionId, sessionId))
            .get();
        return row === undefined || !row.prompted ? null : decodeSummary(row);
    };
    readonly read = (
        runtimeId: string,
        query: RecordingDirectoryQuery = { cursor: null, limit: DEFAULT_PAGE_SIZE, query: "", status: null },
    ): RecordingDirectoryPage => {
        const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, query.limit));
        const decodedCursor = decodeCursor(query.cursor);
        const filter = and(
            eq(recordingSessionSummary.prompted, true),
            eq(recordingSessionSummary.runtimeId, runtimeId),
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
            .where(filter)
            .orderBy(desc(recordingSessionSummary.updatedAt), desc(recordingSessionSummary.sessionId))
            .limit(limit + 1)
            .all();
        const sessions = rows.slice(0, limit).map(decodeSummary);
        const last = sessions.at(-1);
        const nextCursor =
            rows.length > limit && last !== undefined ? encodeCursor(last.updatedAt, last.sessionId) : null;
        return {
            sessions,
            ...(nextCursor === null ? {} : { nextCursor }),
            ...(rows.length > limit ? { truncated: true } : {}),
        };
    };
    readonly delete = (sessionId: string): boolean => {
        const summary = this.find(sessionId);
        if (summary === null) {
            return false;
        }
        this.#database.delete(recordingSessionSummary).where(eq(recordingSessionSummary.sessionId, sessionId)).run();
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
    if (row.projectId === null) {
        throw new Error("Invalid recorded Project identifier");
    }
    return {
        projectId: row.projectId,
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
