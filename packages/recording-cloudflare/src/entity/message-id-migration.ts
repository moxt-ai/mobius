import { z } from "zod";

const ordinal = z.number().int().nonnegative().safe();
const groupSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).readonly(),
    z
        .object({
            kind: z.literal("legacy"),
            chunkKind: z.enum(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]),
            generationId: z.string().min(1),
            messageId: z.string().min(1),
        })
        .readonly(),
]);
export type LegacyMessageGroup = z.infer<typeof groupSchema>;

export const messageIdMigrationProgressSchema = z
    .object({
        kind: z.enum(["running", "complete"]),
        throughOrdinal: ordinal,
        rewrittenEvents: ordinal,
        rewrittenBatches: ordinal,
        group: groupSchema,
    })
    .readonly();
export type MessageIdMigrationProgress = z.infer<typeof messageIdMigrationProgressSchema>;

export const messageIdMigrationRequestSchema = z.discriminatedUnion("mode", [
    z
        .object({ mode: z.literal("dry-run"), afterOrdinal: ordinal.default(0) })
        .strict()
        .readonly(),
    z
        .object({ mode: z.literal("apply") })
        .strict()
        .readonly(),
]);

export class MessageIdMigrationError extends Error {
    readonly code = "message_id_migration_invalid_data";
    constructor(cause: unknown) {
        super("Recording message identity migration could not validate persisted data", { cause });
    }
}
