import { acpSessionStoreMigrations } from "./generated/acp-session-store-migrations.ts";
import { sessionEventCacheMigrations } from "./generated/session-event-cache-migrations.ts";
import { sessionLiveEventPositionMigrations } from "./generated/session-live-event-position-migrations.ts";
import { LocalSqliteDatabase } from "./infra/local-sqlite-database.ts";

export const openAcpSessionDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "ACP Session database", acpSessionStoreMigrations);

export const openSessionEventCacheV2Database = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "V2 Session event cache", sessionEventCacheMigrations, [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = OFF",
    ]);

export const openSessionLiveEventPositionDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "Session live event position database", sessionLiveEventPositionMigrations);
