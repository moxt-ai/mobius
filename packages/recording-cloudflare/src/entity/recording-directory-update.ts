import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";

const identifier = z.string().refine((value: string): boolean => isIdentifier(value));
const recordedAt = z.iso.datetime({ offset: true });
const context = z
    .object({
        agentId: identifier,
        directoryId: z.string().min(1).max(2048),
        additionalDirectoryIds: z.array(identifier).max(16).readonly(),
    })
    .readonly();
export const directoryOperationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("requested"), context, title: z.string().max(1000), recordedAt }).readonly(),
    z.object({ kind: z.literal("status"), status: z.enum(["running", "idle", "failed"]), recordedAt }).readonly(),
    z.object({ kind: z.literal("title"), title: z.string().max(1000), recordedAt }).readonly(),
    z.object({ kind: z.literal("activity"), recordedAt }).readonly(),
]);
export const directoryUpdateSchema = z
    .object({
        projectId: identifier,
        runtimeId: identifier,
        events: z.number().int().min(1).max(1000),
        updates: z
            .array(
                z
                    .object({
                        sessionId: identifier,
                        operations: z.array(directoryOperationSchema).min(1).max(1000).readonly(),
                    })
                    .readonly(),
            )
            .min(1)
            .max(256)
            .readonly(),
    })
    .readonly()
    .refine(
        (write) =>
            new Set(write.updates.map((update) => update.sessionId)).size === write.updates.length &&
            write.updates.reduce((count, update) => count + update.operations.length, 0) <= 1000,
    );
export type DirectoryOperation = z.infer<typeof directoryOperationSchema>;
export type RecordingDirectoryUpdate = z.infer<typeof directoryUpdateSchema>;
