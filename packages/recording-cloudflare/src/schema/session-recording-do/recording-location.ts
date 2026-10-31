import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Where this Runtime's Session history lives. Histories recorded before Recording was addressed by Runtime stay in
// the Session's legacy object, which the first writer owns; every other history lives in this object.
export const recordingLocation = sqliteTable(
    "recording_location",
    {
        singleton: integer("singleton").primaryKey(),
        location: text("location", { enum: ["local", "legacy"] }).notNull(),
    },
    (table) => [
        check("recording_location_singleton_check", sql`${table.singleton} = 1`),
        check("recording_location_location_check", sql`${table.location} IN ('local', 'legacy')`),
    ],
);
