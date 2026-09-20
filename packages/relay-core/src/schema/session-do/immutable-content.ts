import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const immutableContent = sqliteTable(
    "immutable_content",
    {
        objectKey: text("object_key").primaryKey(),
        bytes: blob("bytes", { mode: "buffer" }).notNull(),
        byteLength: integer("byte_length").notNull(),
        contentEncoding: text("content_encoding", { enum: ["gzip", "identity"] }).notNull(),
        mediaType: text("media_type").notNull(),
        sha256: text("sha256").notNull(),
    },
    (_table) => [
        check("immutable_content_byte_length_check", sql`byte_length >= 0`),
        check("immutable_content_content_encoding_check", sql`content_encoding IN ('gzip', 'identity')`),
        check("immutable_content_sha256_check", sql`length(sha256) = 64`),
    ],
);
