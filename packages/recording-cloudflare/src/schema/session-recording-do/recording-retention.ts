import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const recordingRetention = sqliteTable("recording_retention", {
    singleton: integer("singleton").primaryKey(),
    retentionMilliseconds: integer("retention_milliseconds").notNull(),
    configuredAt: integer("configured_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    state: text("state", { enum: ["managed"] }).notNull(),
});
