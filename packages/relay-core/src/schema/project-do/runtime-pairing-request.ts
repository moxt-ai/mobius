import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runtimePairingRequest = sqliteTable(
    "runtime_pairing_requests",
    {
        pairingId: text("pairing_id").primaryKey(),
        runtimeId: text("runtime_id").notNull().unique(),
        pairingCodeHash: text("pairing_code_hash").notNull().unique(),
        pollTokenHash: text("poll_token_hash").notNull(),
        expiresAt: integer("expires_at").notNull(),
        // Each Project has its own database. Its idempotency namespace is the
        // database boundary, not a second copy of the Runtime's project_id.
        creationIdempotencyKey: text("creation_idempotency_key").unique(),
        createdByOwnerCredentialId: text("created_by_owner_credential_id"),
    },
    (table) => [index("runtime_pairing_requests_expires_at").on(table.expiresAt)],
);
