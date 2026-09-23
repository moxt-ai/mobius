import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const externalIdentityBinding = sqliteTable(
    "external_identity_bindings",
    {
        bindingId: text("binding_id").primaryKey(),
        providerId: text("provider_id").notNull(),
        issuer: text("issuer").notNull(),
        subject: text("subject").notNull(),
        metadataJson: text("metadata_json").notNull(),
        createdAt: integer("created_at").notNull(),
        lastVerifiedAt: integer("last_verified_at").notNull(),
    },
    (table) => [
        unique().on(table.providerId, table.issuer, table.subject),
        index("external_identity_bindings_lookup").on(table.providerId, table.issuer, table.subject),
    ],
);
