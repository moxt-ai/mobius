import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionBindings = sqliteTable(
    "session_bindings",
    {
        scopeKey: text("scope_key").notNull(),
        sessionId: text("session_id").notNull(),
        bindingId: text("binding_id").notNull(),
        runtimeId: text("runtime_id").notNull(),
        agentRef: text("agent_ref").notNull(),
        workspaceRef: text("workspace_ref").notNull(),
        configRevision: integer("config_revision").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.scopeKey, table.sessionId, table.bindingId] })],
);
