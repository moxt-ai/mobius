import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acpSessionStoreMigrations } from "../../generated/acp-session-store-migrations.ts";
import { commandCancellationMigrations } from "../../generated/command-cancellation-migrations.ts";
import { sessionEventCacheMigrations } from "../../generated/session-event-cache-migrations.ts";
import { LocalSqliteDatabase } from "./local-sqlite-database.ts";

export interface ChannelSessionDatabasePaths {
    readonly cancellations: string;
    readonly events: string;
    readonly sessions: string;
}

/** Each relay channel keeps its saved sessions and its spilled session events in its own files. */
export function channelSessionDatabasePaths(stateDirectory: string, channelId: string): ChannelSessionDatabasePaths {
    const channelHash = createHash("sha256").update(channelId).digest("hex");
    return {
        cancellations: join(stateDirectory, "sessions", `${channelHash}.cancellations.sqlite`),
        events: join(stateDirectory, "sessions", `${channelHash}.events.sqlite`),
        sessions: join(stateDirectory, "sessions", `${channelHash}.sqlite`),
    };
}

/**
 * CLI 0.0.350 and later releases before this repair applied migration 0009 without recording it in `user_version`,
 * so their databases report 9 while already holding `admission_order`. Record it so 0009 does not run again.
 */
function recordAppliedAdmissionOrder(path: string): void {
    if (!existsSync(path)) {
        return;
    }
    const database = new DatabaseSync(path);
    try {
        const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
        const column = database
            .prepare("SELECT name FROM pragma_table_info('execution_receipt') WHERE name = 'admission_order'")
            .get();
        if (version === 9 && column !== undefined) {
            database.exec("PRAGMA user_version = 10");
        }
    } finally {
        database.close();
    }
}

export const openAcpSessionDatabase = (path: string): LocalSqliteDatabase => {
    recordAppliedAdmissionOrder(path);
    return new LocalSqliteDatabase(path, "ACP Session database", acpSessionStoreMigrations);
};

/** A separate migration history keeps old Session database readers usable during rollback. */
export const openCommandCancellationDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "Command cancellation database", commandCancellationMigrations);

export const openSessionEventCacheDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "V2 Session event cache", sessionEventCacheMigrations, [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = OFF",
        "PRAGMA auto_vacuum = FULL",
    ]);
