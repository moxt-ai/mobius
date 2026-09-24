import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const deletedAcpSession = sqliteTable("deleted_acp_session", {
    sessionId: text("session_id").primaryKey(),
});
