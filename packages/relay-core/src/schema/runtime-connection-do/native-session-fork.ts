import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A Fork's original result is a receipt, independent of the Session's current metadata. */
export const nativeSessionFork = sqliteTable(
    "native_session_forks",
    {
        projectId: text("project_id").notNull(),
        operationId: text("operation_id").notNull(),
        requestHash: text("request_hash").notNull(),
        resultJson: text("result_json"),
    },
    (table) => [primaryKey({ columns: [table.projectId, table.operationId] })],
);
