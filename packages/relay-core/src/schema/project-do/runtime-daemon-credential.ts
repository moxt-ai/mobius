import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runtimeDaemonCredential = sqliteTable("runtime_daemon_credentials", {
    runtimeId: text("runtime_id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
});
