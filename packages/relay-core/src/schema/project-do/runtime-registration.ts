import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A row records a completed claim. Pending requests have no registration and
// therefore need no placeholder machine name, workspace, or Agent catalog.
export const runtimeRegistration = sqliteTable("runtime_registrations", {
    runtimeId: text("runtime_id").primaryKey(),
    claimedAt: integer("claimed_at").notNull(),
    machineName: text("machine_name").notNull(),
    workspaceName: text("workspace_name").notNull(),
    agentsJson: text("agents_json").notNull(),
});
