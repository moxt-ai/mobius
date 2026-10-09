import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const acpSession = sqliteTable("acp_session", {
    sessionId: text("session_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    nativeSessionId: text("native_session_id").notNull(),
    cwd: text("cwd").notNull(),
    additionalDirectories: text("additional_directories").notNull(),
    prompted: integer("prompted", { mode: "boolean" }).notNull(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
});
