import { isDirectoryIdentifier, isIdentifier, SESSION_RECORDING_TITLE_MAX_LENGTH } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";
import { recordedSessionTitle } from "./session-title.ts";

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
const title = z.string().max(SESSION_RECORDING_TITLE_MAX_LENGTH);
const requestedOperation = z.object({ kind: z.literal("requested"), context, title, recordedAt }).readonly();
const activityOperation = z.object({ kind: z.literal("activity"), recordedAt }).readonly();
export const directoryOperationSchema = z.discriminatedUnion("kind", [
    requestedOperation,
    z.object({ kind: z.literal("title"), title, recordedAt }).readonly(),
    activityOperation,
]);
/**
 * Decodes the operations of a committed directory change. A change committed before Agent titles were bounded
 * when projected may hold an Agent's title verbatim, so a title is read through the same title rule, which leaves
 * every title committed since unchanged.
 */
export const committedDirectoryOperationsSchema = z
    .discriminatedUnion("kind", [
        requestedOperation,
        z
            .object({ kind: z.literal("title"), title: z.string().transform(recordedSessionTitle), recordedAt })
            .readonly(),
        activityOperation,
    ])
    .array();
const directoryUpdateEntrySchema = z
    .object({
        sessionId: identifier,
        operations: z.array(directoryOperationSchema).min(1).max(1000).readonly(),
    })
    .readonly();
export const directoryUpdateSchema = z
    .object({
        projectId: identifier,
        runtimeId: identifier,
        events: z.number().int().min(1).max(1000),
        updates: z.array(directoryUpdateEntrySchema).min(1).max(256).readonly(),
    })
    .readonly()
    .refine(
        (write) =>
            new Set(write.updates.map((update) => update.sessionId)).size === write.updates.length &&
            write.updates.reduce((count, update) => count + update.operations.length, 0) <= 1000,
    );
export type DirectoryOperation = z.infer<typeof directoryOperationSchema>;

/** Directory operations a Recording batch implies, committed with the batch until the directory confirms them. */
export interface DirectoryChange {
    readonly operations: readonly DirectoryOperation[];
    readonly events: number;
}

export interface PendingDirectoryChange extends DirectoryChange {
    readonly ordinal: number;
}
export type RecordingDirectoryUpdate = z.infer<typeof directoryUpdateSchema>;

/** Decodes an update for consumption, omitting entries this deployment cannot consume. */
export function decodeKnownDirectoryUpdate(value: unknown): RecordingDirectoryUpdate | null {
    if (typeof value !== "object" || value === null || !("updates" in value) || !Array.isArray(value.updates)) {
        return directoryUpdateSchema.parse(value);
    }
    const updates = z
        .array(z.unknown())
        .max(256)
        .parse(value.updates)
        .flatMap((update) => {
            if (typeof update !== "object" || update === null || !("operations" in update)) {
                return [];
            }
            const operations = z.array(z.unknown()).max(1000).safeParse(update.operations);
            if (!operations.success) {
                return [];
            }
            const knownOperations = operations.data.flatMap((operation) => {
                const decoded = directoryOperationSchema.safeParse(operation);
                return decoded.success ? [decoded.data] : [];
            });
            const decoded = directoryUpdateEntrySchema.safeParse({ ...update, operations: knownOperations });
            return decoded.success ? [decoded.data] : [];
        });
    return updates.length === 0 ? null : directoryUpdateSchema.parse({ ...value, updates });
}
