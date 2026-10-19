import { acpSessionStoreMigrations } from "./generated/acp-session-store-migrations.ts";
import { sessionEventCacheMigrations } from "./generated/session-event-cache-migrations.ts";
import { LocalSqliteDatabase } from "./infra/local-sqlite-database.ts";

export const openAcpSessionDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "ACP Session database", acpSessionStoreMigrations);

export const openSessionEventCacheDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "V2 Session event cache", sessionEventCacheMigrations, [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = OFF",
    ]);
