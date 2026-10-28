import { createHash } from "node:crypto";
import { join } from "node:path";
import { acpSessionStoreMigrations } from "../../generated/acp-session-store-migrations.ts";
import { sessionEventCacheMigrations } from "../../generated/session-event-cache-migrations.ts";
import { LocalSqliteDatabase } from "./local-sqlite-database.ts";

export interface ChannelSessionDatabasePaths {
    readonly events: string;
    readonly sessions: string;
}

/** Each relay channel keeps its saved sessions and its spilled session events in its own files. */
export function channelSessionDatabasePaths(stateDirectory: string, channelId: string): ChannelSessionDatabasePaths {
    const channelHash = createHash("sha256").update(channelId).digest("hex");
    return {
        events: join(stateDirectory, "sessions", `${channelHash}.events.sqlite`),
        sessions: join(stateDirectory, "sessions", `${channelHash}.sqlite`),
    };
}

export const openAcpSessionDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "ACP Session database", acpSessionStoreMigrations);

export const openSessionEventCacheDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "V2 Session event cache", sessionEventCacheMigrations, [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = OFF",
        "PRAGMA auto_vacuum = FULL",
    ]);
