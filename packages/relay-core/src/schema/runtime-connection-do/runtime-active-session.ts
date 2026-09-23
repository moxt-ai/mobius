import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The Sessions a Runtime currently has outstanding work for.
 *
 * Settling a Runtime disconnect means marking every in-flight Attempt indeterminate, and that state lives
 * inside each Session Durable Object. Walking every ready Session of the Project to find those Attempts made
 * a Runtime attach scale with the Project's Session count: a Project with enough Sessions pushed the attach
 * past the daemon's connection deadline, so the daemon timed out, reconnected, and timed out again.
 *
 * The Channel records the Sessions it actually hands work to, so a disconnect only revisits Sessions that
 * can still be in flight. A Session whose Turn already finished is never revisited.
 */
export const runtimeActiveSession = sqliteTable(
    "runtime_active_sessions",
    {
        runtimeId: text("runtime_id").notNull(),
        sessionId: text("session_id").notNull(),
        connectionEpoch: integer("connection_epoch").notNull(),
        recordedAt: integer("recorded_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.runtimeId, table.sessionId] })],
);
