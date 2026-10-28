import { isDirectoryIdentifier, isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";

const identifier = z.string().refine((value: string): boolean => isIdentifier(value));
const directoryIdentifier = z.string().refine(isDirectoryIdentifier);
const recordedAt = z.iso.datetime({ offset: true });
const context = z
    .object({
        agentId: identifier,
        directoryId: directoryIdentifier,
        additionalDirectoryIds: z.array(directoryIdentifier).max(16).readonly(),
    })
    .readonly();
export const directoryOperationSchema = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("requested"), context, title: z.string().max(1000), recordedAt }).readonly(),
        // In-flight writes from older Workers still count as activity, without retaining their status.
        z.object({ kind: z.literal("status"), status: z.enum(["running", "idle", "failed"]), recordedAt }).readonly(),
        z.object({ kind: z.literal("title"), title: z.string().max(1000), recordedAt }).readonly(),
        z.object({ kind: z.literal("activity"), recordedAt }).readonly(),
    ])
    .transform((operation) =>
        operation.kind === "status" ? { kind: "activity" as const, recordedAt: operation.recordedAt } : operation,
    );
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

const knownDirectoryOperationKinds = new Set(["activity", "requested", "status", "title"]);

/** Decodes an update for consumption, omitting operation variants this deployment does not know. */
export function decodeKnownDirectoryUpdate(value: unknown): RecordingDirectoryUpdate | null {
    if (typeof value !== "object" || value === null || !("updates" in value) || !Array.isArray(value.updates)) {
        return directoryUpdateSchema.parse(value);
    }
    const updates = value.updates
        .map((update) => {
            if (
                typeof update !== "object" ||
                update === null ||
                !("operations" in update) ||
                !Array.isArray(update.operations)
            ) {
                return update;
            }
            return {
                ...update,
                operations: update.operations.filter(
                    (operation: unknown) =>
                        typeof operation !== "object" ||
                        operation === null ||
                        !("kind" in operation) ||
                        typeof operation.kind !== "string" ||
                        knownDirectoryOperationKinds.has(operation.kind),
                ),
            };
        })
        .filter(
            (update) =>
                typeof update !== "object" ||
                update === null ||
                !("operations" in update) ||
                !Array.isArray(update.operations) ||
                update.operations.length > 0,
        );
    return updates.length === 0 ? null : directoryUpdateSchema.parse({ ...value, updates });
}
