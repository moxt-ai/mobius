import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runtimeConnectionState = sqliteTable(
    "runtime_connection_state",
    {
        singleton: integer("singleton").primaryKey(),
        runtimeId: text("runtime_id").notNull(),
        connectionEpoch: integer("connection_epoch").notNull(),
        connectionId: text("connection_id").notNull(),
        state: text("state", { enum: ["online", "offline"] }).notNull(),
        connectedAt: integer("connected_at").notNull(),
        disconnectedAt: integer("disconnected_at"),
    },
    (table) => [
        check("runtime_connection_state_singleton_check", sql`${table.singleton} = 1`),
        check("runtime_connection_state_state_check", sql`${table.state} in ('online', 'offline')`),
    ],
);
