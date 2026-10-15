import {
    sessionRecordingInteractionSchema,
    sessionRecordingTurnAttemptSchema,
    sessionRecordingTurnItemSchema,
    sessionRecordingTurnPromptSchema,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";

const count = z.number().int().nonnegative().safe();

/** A projected Turn together with the fold state its later Recording events need. */
export const storedTurnSchema = z
    .object({
        answerLength: count,
        attempt: sessionRecordingTurnAttemptSchema,
        commandId: z.string().min(1),
        createdAt: z.iso.datetime({ offset: true }),
        generationId: z.string().min(1),
        itemCount: count,
        messageId: z.string().nullable(),
        nextSequence: count,
        // The answer item that the next answer chunk extends; reasoning and tool work close it.
        openAnswerItemId: z.string().nullable(),
        order: z.number().int().positive().safe(),
        prompt: sessionRecordingTurnPromptSchema.nullable(),
        // Advances whenever answer text or tool work interrupts reasoning, so later thoughts get a new item.
        thoughtSegment: count,
    })
    .readonly();
export type StoredTurn = z.infer<typeof storedTurnSchema>;

/** Items are stored in their complete form; pages bound them when they are read. */
export const storedTurnItemSchema = sessionRecordingTurnItemSchema;
export type StoredTurnItem = z.infer<typeof storedTurnItemSchema>;

export const storedInteractionSchema = sessionRecordingInteractionSchema;
export type StoredInteraction = z.infer<typeof storedInteractionSchema>;

/** Session-wide fold state carried from one folded batch to the next. */
export const storedProjectionStateSchema = z
    .object({
        // Commands that own Agent output in the newest generation, innermost last.
        activeCommands: z
            .object({ commandIds: z.array(z.string().min(1)).readonly(), generationId: z.string().min(1) })
            .readonly()
            .nullable(),
        // Generation of the last folded event; a different generation clears the active commands.
        generationId: z.string().min(1).nullable(),
        title: z.string().nullable(),
    })
    .readonly();
export type StoredProjectionState = z.infer<typeof storedProjectionStateSchema>;

export interface StoredProjection {
    readonly foldedThroughOrdinal: number;
    readonly state: StoredProjectionState;
    readonly turnCount: number;
}

export const emptyProjectionState: StoredProjectionState = { activeCommands: null, generationId: null, title: null };
