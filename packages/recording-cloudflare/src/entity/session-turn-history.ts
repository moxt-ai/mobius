import {
    decodeSessionRecordingInteraction,
    decodeSessionRecordingTurnAttempt,
    decodeSessionRecordingTurnItem,
    decodeSessionRecordingTurnPreceding,
    decodeSessionRecordingTurnPrompt,
} from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";

const count = z.number().int().nonnegative().safe();

function decodedProtocolValue<T>(decode: (value: unknown) => T): z.ZodType<T> {
    return z.unknown().transform((value, context) => {
        try {
            return decode(value);
        } catch {
            context.addIssue({ code: "custom", message: "Value does not match the Mobius protocol" });
            return z.NEVER;
        }
    });
}

const sessionRecordingTurnAttempt = decodedProtocolValue(decodeSessionRecordingTurnAttempt);
const sessionRecordingTurnItem = decodedProtocolValue(decodeSessionRecordingTurnItem);
const sessionRecordingTurnPreceding = decodedProtocolValue(decodeSessionRecordingTurnPreceding);
const sessionRecordingTurnPrompt = decodedProtocolValue(decodeSessionRecordingTurnPrompt);
const sessionRecordingInteraction = decodedProtocolValue(decodeSessionRecordingInteraction);

/** A projected Turn together with the fold state its later Recording events need. */
export const storedTurnSchema = z
    .object({
        answerLength: count,
        attempt: sessionRecordingTurnAttempt,
        commandId: z.string().min(1),
        createdAt: z.iso.datetime({ offset: true }),
        generationId: z.string().min(1),
        itemCount: count,
        messageId: z.string().nullable(),
        nextSequence: count,
        // The answer item that the next answer chunk of the same message extends; reasoning, tool
        // work, and answer text from another message close it.
        openAnswer: z.object({ itemId: z.string(), messageId: z.string().nullable() }).readonly().nullable(),
        // The thought item that the next reasoning chunk of the same message extends; answer text and
        // tool work close it, and reasoning from another message starts a new item.
        openThought: z.object({ itemId: z.string(), messageId: z.string().nullable() }).readonly().nullable(),
        order: z.number().int().positive().safe(),
        // Null when no other command was running when the prompt was requested. A Turn folded before
        // this was recorded has no such key at all, and it is read as the anchor it is: a prompt that
        // was not placed between another command's work.
        preceding: sessionRecordingTurnPreceding.nullish().transform((value) => value ?? null),
        prompt: sessionRecordingTurnPrompt.nullable(),
    })
    .readonly();
export type StoredTurn = z.infer<typeof storedTurnSchema>;

/**
 * Item fields as stored. Answer and thought text is kept outside this record, so stored text items
 * carry an empty `text` and `omittedCharacters`; reads fill both from the stored text.
 */
export const storedTurnItemSchema = sessionRecordingTurnItem;
export type StoredTurnItem = z.infer<typeof storedTurnItemSchema>;

export const storedInteractionSchema = sessionRecordingInteraction;
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
        // Generations that a later one replaced. A batch from one of them arrives late and is not a restart.
        retiredGenerationIds: z.array(z.string().min(1)).readonly(),
        title: z.string().nullable(),
        // Version 1 did not deduplicate event identities and must be rebuilt before further folding.
        version: z.union([z.literal(1), z.literal(2)]).default(1),
    })
    .readonly();
export type StoredProjectionState = z.infer<typeof storedProjectionStateSchema>;

/** Folding the batch after the projection failed; backfill retries it at `retryAt`. */
export const storedProjectionFailureSchema = z
    .object({
        attempts: z.number().int().positive().safe(),
        code: z.literal("projection_fold_failed"),
        failedAt: z.iso.datetime({ offset: true }),
        retryAt: z.iso.datetime({ offset: true }),
    })
    .readonly();
export type StoredProjectionFailure = z.infer<typeof storedProjectionFailureSchema>;

export interface StoredProjection {
    readonly failure: StoredProjectionFailure | null;
    readonly foldedThroughOrdinal: number;
    readonly state: StoredProjectionState;
    readonly turnCount: number;
}

export const emptyProjection: StoredProjection = {
    failure: null,
    foldedThroughOrdinal: 0,
    state: { activeCommands: null, generationId: null, retiredGenerationIds: [], title: null, version: 2 },
    turnCount: 0,
};

export interface StoredInteractionRecord {
    readonly interaction: StoredInteraction;
    readonly requestedAt: number;
    readonly resolved: boolean;
}

/**
 * How a write changes an item's stored answer or thought text: the text it adds in order, then the
 * characters it folded but cannot store, such as an unreadable chunk and everything after it.
 */
export type ItemTextChange =
    | { readonly kind: "append"; readonly text: string; readonly droppedCharacters: number }
    | { readonly kind: "set"; readonly text: string; readonly droppedCharacters: number };

export interface TurnItemWrite {
    readonly commandId: string;
    readonly item: StoredTurnItem;
    // The bounded item a page lists; null for text items, which are bounded from their text.
    readonly listing: StoredTurnItem | null;
    readonly text: ItemTextChange;
}

/** Everything one fold commits; storage encodes all of it before writing any of it. */
export interface ProjectionWrites {
    readonly events: readonly ProjectedEventIdentity[];
    readonly interactions: readonly StoredInteractionRecord[];
    readonly items: readonly TurnItemWrite[];
    readonly projection: StoredProjection;
    readonly turns: readonly { readonly open: boolean; readonly turn: StoredTurn }[];
}

export interface ProjectedEventIdentity {
    readonly eventId: string;
    readonly generationId: string;
}

export const projectedEventKey = (event: ProjectedEventIdentity): string =>
    JSON.stringify([event.generationId, event.eventId]);

/**
 * UTF-8 bytes an item's stored text or encoded fields may take. Durable Object SQLite rejects a string
 * or row larger than 2 MB, and a fold that cannot write an item blocks every later Turn of its Session,
 * so stored items stay just inside that limit: anything a row could hold is still stored whole.
 */
export const storedTurnItemBytes = 1_900_000;

/** Characters as SQLite counts them in stored text: a surrogate pair is one character. */
export function characterCount(text: string): number {
    let pairs = 0;
    for (let index = 0; index + 1 < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        const next = text.charCodeAt(index + 1);
        if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            pairs += 1;
            index += 1;
        }
    }
    return text.length - pairs;
}

/** A stored item as a read sees it: its fields, its bounded listing, and a prefix of its text. */
export interface StoredTurnItemRead {
    readonly item: StoredTurnItem;
    readonly listing: StoredTurnItem | null;
    // Characters of stored text, counted as SQLite counts them.
    readonly textLength: number;
    readonly textPrefix: string;
    // Characters folded into the item after its stored text was full; no read can return them.
    readonly droppedCharacters: number;
}
