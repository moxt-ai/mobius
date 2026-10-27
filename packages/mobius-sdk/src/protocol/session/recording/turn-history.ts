import { z } from "zod";

import { identifierStringSchema } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import {
    sessionElicitationRequestedEventSchema,
    sessionPermissionRequestedEventSchema,
} from "../interactions/index.ts";
import {
    boundedJsonSchema,
    contentBlockSchema,
    toolCallContentSchema,
    toolCallLocationSchema,
    toolKindSchema,
    toolStatusSchema,
} from "../observability/event-log.ts";
import { recordingCursorSchema } from "./recording.ts";

/**
 * Turns a caller may request from a Turn history page at most. This bounds the request only: a
 * service counts a page against it, and a page also stays inside a serialized-character budget, so
 * the request bound never sets how large a response can be.
 */
export const SESSION_RECORDING_TURN_PAGE_MAX_LIMIT = 100;
/**
 * Items a caller may request from a Turn item page at most. As with the Turn bound this is a
 * request limit, not a limit on what a service lists.
 */
export const SESSION_RECORDING_TURN_ITEM_PAGE_MAX_LIMIT = 1_000;
/**
 * Elements a page may carry when decoded. The request bounds above are a contract a service is
 * expected to honour, so they are not what a decoder is willing to read: a service lists up to a
 * per-Turn budget of its own, independent of anything a caller requested, and a caller that rejects
 * a service listing more than it asked for would rather fail the whole read than render it. This
 * bound is deliberately decoupled from both request limits and left unchanged when those move, so
 * one deployment's idea of a page size can never decode as `invalid_service_response` in another's.
 * A page's serialized-character budget is what bounds its actual size.
 */
export const SESSION_RECORDING_TURN_PAGE_DECODE_MAX_ELEMENTS = 10_000;
/** Longest Turn item identifier. */
export const SESSION_RECORDING_TURN_ITEM_ID_MAX_LENGTH = 4_200;

function cursorPosition(value: string, pattern: RegExp): number | null {
    const position = Number(pattern.exec(value)?.[1] ?? Number.NaN);
    return Number.isSafeInteger(position) ? position : null;
}

/** The Turn order a Turn history cursor continues before, or null when the cursor is malformed. */
export const parseSessionRecordingTurnCursor = (value: string): number | null =>
    cursorPosition(value, /^turn:([1-9][0-9]*)$/u);

/** The edge of a run of a Turn's items: `before` reads back toward the work a Turn did earlier. */
export type SessionRecordingTurnItemCursorDirection = "after" | "before";

/**
 * A Turn item cursor, or null when the value is not one. A cursor names both a position and the
 * direction the read continues from it, so a page returned for one direction can never be fed to
 * the other: the two runs would overlap and a member would read the same work twice.
 */
export const parseSessionRecordingTurnItemCursor = (
    value: string,
): { readonly direction: SessionRecordingTurnItemCursorDirection; readonly sequence: number } | null => {
    const matched = /^(before|after):item:(0|[1-9][0-9]*)$/u.exec(value);
    if (matched === null) {
        return null;
    }
    const sequence = Number(matched[2]);
    return Number.isSafeInteger(sequence)
        ? { direction: matched[1] as SessionRecordingTurnItemCursorDirection, sequence }
        : null;
};

/** The Turn item cursor that continues a run at `sequence` in `direction`. */
export const sessionRecordingTurnItemCursor = (
    direction: SessionRecordingTurnItemCursorDirection,
    sequence: number,
): string => `${direction}:item:${sequence}`;

/** A page size between 1 and `maximum`, or null when the value is not one. */
export function parseSessionRecordingPageLimit(value: string, maximum: number): number | null {
    if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
        return null;
    }
    const limit = Number(value);
    return limit <= maximum ? limit : null;
}

const isoTimestamp = z.iso.datetime({ offset: true });
const shortText = z.string().max(2_048);
// A full item read is not bounded by the page budget; a merged answer can exceed one chunk's limit.
const itemText = z.string().max(50_000_000);
// Opaque Turn history cursors: a page continues with Turns older than the Turn order it names.
const turnCursorSchema = z.string().regex(/^turn:[1-9][0-9]*$/);
// Opaque Turn item cursors: a page continues in the direction the cursor names, from the item
// sequence it names.
const turnItemCursorSchema = z.string().regex(/^(?:before|after):item:(?:0|[1-9][0-9]*)$/);

const attemptTiming = {
    attemptId: identifierStringSchema.optional(),
    startedAt: isoTimestamp.optional(),
};

// Terminal prompt outcomes, shared so a Turn read model and a status notification cannot disagree
// on what a finished prompt looks like.
const promptSucceededOutcome = { completedAt: isoTimestamp, stopReason: shortText };
const promptCancelledOutcome = { cancelledAt: isoTimestamp };
const promptFailedOutcome = {
    code: identifierStringSchema,
    failedAt: isoTimestamp,
    message: z.string().min(1).max(500),
};

/** Where a Turn's prompt is in its lifecycle, as projected from Recording lifecycle events. */
export const sessionRecordingTurnAttemptSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).readonly(),
    z.object({ ...attemptTiming, kind: z.literal("running") }).readonly(),
    z
        .object({
            ...attemptTiming,
            interactionIds: z.array(identifierStringSchema).min(1).max(100).readonly(),
            kind: z.literal("waiting_input"),
        })
        .readonly(),
    z.object({ ...attemptTiming, ...promptSucceededOutcome, kind: z.literal("succeeded") }).readonly(),
    z.object({ ...attemptTiming, ...promptCancelledOutcome, kind: z.literal("cancelled") }).readonly(),
    z.object({ ...attemptTiming, ...promptFailedOutcome, kind: z.literal("failed") }).readonly(),
    // A Session generation change restarted the local Agent process before this attempt ended.
    z
        .object({
            ...attemptTiming,
            detectedAt: isoTimestamp,
            kind: z.literal("indeterminate"),
            reason: z.literal("session_generation_changed"),
        })
        .readonly(),
]);

const turnItemBase = {
    // Opaque and stable for the life of the item; derived from the event, message, or tool call it merges.
    itemId: z.string().min(1).max(SESSION_RECORDING_TURN_ITEM_ID_MAX_LENGTH),
    // Creation order inside the Turn; answer, thought, and tool items share one sequence.
    sequence: z.number().int().nonnegative().safe(),
};

// Text items list at most a bounded prefix; `omittedCharacters` counts what a full item read returns.
const textItemFields = {
    omittedCharacters: z.number().int().nonnegative().safe(),
    text: itemText,
};

const sessionRecordingToolDetailSchema = z.discriminatedUnion("kind", [
    z
        .object({
            content: z.array(toolCallContentSchema).max(1_000).readonly(),
            kind: z.literal("inline"),
            rawInput: boundedJsonSchema.optional(),
            rawOutput: boundedJsonSchema.optional(),
        })
        .readonly(),
    // The detail exceeded the page bound; a full item read returns it inline.
    z.object({ kind: z.literal("omitted") }).readonly(),
]);

export const sessionRecordingTurnItemSchema = z.discriminatedUnion("kind", [
    z.object({ ...turnItemBase, ...textItemFields, kind: z.literal("answer") }).readonly(),
    z.object({ ...turnItemBase, ...textItemFields, kind: z.literal("thought") }).readonly(),
    z
        .object({
            ...turnItemBase,
            attemptId: identifierStringSchema.optional(),
            detail: sessionRecordingToolDetailSchema,
            kind: z.literal("tool"),
            locations: z.array(toolCallLocationSchema).max(1_000).readonly(),
            name: shortText.nullable(),
            status: toolStatusSchema.nullable(),
            title: itemText,
            toolCallId: shortText,
            toolKind: toolKindSchema.nullable(),
        })
        .readonly(),
]);

export const sessionRecordingTurnPromptSchema = z
    .object({
        content: z.array(contentBlockSchema).min(1).max(100).readonly(),
        disposition: shortText.optional(),
        targetCommandId: identifierStringSchema.optional(),
    })
    .readonly();

export const sessionRecordingTurnPrecedingSchema = z
    .object({
        commandId: identifierStringSchema,
        itemCount: z.number().int().nonnegative().safe(),
    })
    .readonly();

const sessionRecordingTurnSchema = z
    .object({
        answerLength: z.number().int().nonnegative().safe(),
        attempt: sessionRecordingTurnAttemptSchema,
        commandId: identifierStringSchema,
        createdAt: isoTimestamp,
        generationId: identifierStringSchema,
        itemCount: z.number().int().nonnegative().safe(),
        items: z.array(sessionRecordingTurnItemSchema).max(SESSION_RECORDING_TURN_PAGE_DECODE_MAX_ELEMENTS).readonly(),
        // Continues this Turn's items before the listed run, or null when every item is listed. A
        // page starts from the end of a Turn's sequence, so what it leaves out is the work that
        // produced the conclusion it does show; this cursor reads that work back.
        itemsCursor: turnItemCursorSchema.nullable(),
        messageId: shortText.nullable(),
        // Creation order of Turns in the Session; newer Turns have larger orders.
        order: z.number().int().positive().safe(),
        // Null when the Recording holds Agent output for a command whose prompt it never recorded.
        prompt: sessionRecordingTurnPromptSchema.nullable(),
        // The command whose work was running when this prompt was requested and how many items it had
        // by then, so a prompt that records no work of its own (a steer) can be placed where it was sent.
        // Null when no other command was running.
        preceding: sessionRecordingTurnPrecedingSchema.nullable(),
    })
    .readonly();

export const sessionRecordingInteractionSchema = z.discriminatedUnion("kind", [
    z
        .object({
            commandId: identifierStringSchema,
            event: sessionPermissionRequestedEventSchema,
            interactionId: identifierStringSchema,
            kind: z.literal("permission"),
        })
        .readonly(),
    z
        .object({
            commandId: identifierStringSchema,
            event: sessionElicitationRequestedEventSchema,
            interactionId: identifierStringSchema,
            kind: z.literal("elicitation"),
        })
        .readonly(),
]);

export const SESSION_RECORDING_EXECUTION_COMMAND_MAX_LIMIT = 100;

const recordingActiveCommandsSchema = z
    .object({
        commandIds: z.array(identifierStringSchema).max(1_000).readonly(),
        generationId: identifierStringSchema,
    })
    .readonly()
    .nullable();

const sessionRecordingExecutionSchema = z
    .object({
        activeCommands: recordingActiveCommandsSchema,
        commands: z
            .array(
                z
                    .object({
                        attempt: sessionRecordingTurnAttemptSchema,
                        commandId: identifierStringSchema,
                        generationId: identifierStringSchema,
                    })
                    .readonly(),
            )
            .max(SESSION_RECORDING_EXECUTION_COMMAND_MAX_LIMIT)
            .readonly(),
        sessionId: identifierStringSchema,
        tailCursor: recordingCursorSchema,
        version: z.literal(1),
    })
    .readonly();

/** Named execution facts, without prompts or output. Missing commands have no recorded evidence yet. */
export type SessionRecordingExecution = z.infer<typeof sessionRecordingExecutionSchema>;

export const decodeSessionRecordingExecution = (encoded: string): SessionRecordingExecution =>
    decode(encoded, sessionRecordingExecutionSchema);

export const encodeSessionRecordingExecution = (value: SessionRecordingExecution): string =>
    JSON.stringify(sessionRecordingExecutionSchema.parse(value));

const sessionRecordingTurnPageSchema = z
    .object({
        // Commands that own Agent output in the newest Session generation, innermost last.
        activeCommands: z
            .object({
                commandIds: z.array(identifierStringSchema).max(1_000).readonly(),
                generationId: identifierStringSchema,
            })
            .readonly()
            .nullable(),
        // Requests still waiting for an answer in a Turn that can still receive one.
        interactions: z.array(sessionRecordingInteractionSchema).max(1_000).readonly(),
        // Continues with older Turns, or null when the oldest Turn is listed.
        nextCursor: turnCursorSchema.nullable(),
        sessionId: identifierStringSchema,
        // The Recording cursor at the last event this snapshot includes; live reads continue after it.
        tailCursor: recordingCursorSchema,
        title: z.string().max(1_000).nullable(),
        turns: z.array(sessionRecordingTurnSchema).max(SESSION_RECORDING_TURN_PAGE_DECODE_MAX_ELEMENTS).readonly(),
        version: z.literal(1),
    })
    .readonly();

const sessionRecordingTurnItemPageSchema = z
    .object({
        commandId: identifierStringSchema,
        items: z.array(sessionRecordingTurnItemSchema).max(SESSION_RECORDING_TURN_PAGE_DECODE_MAX_ELEMENTS).readonly(),
        // Continues from the edge of this page in the direction it was read: `before` reads back
        // toward a Turn's earlier work, `after` forward toward the work it is still producing. Null
        // when the run reached that end of the Turn.
        nextCursor: turnItemCursorSchema.nullable(),
        sessionId: identifierStringSchema,
        version: z.literal(1),
    })
    .readonly();

const sessionRecordingTurnItemDetailSchema = z
    .object({
        commandId: identifierStringSchema,
        item: sessionRecordingTurnItemSchema,
        sessionId: identifierStringSchema,
        version: z.literal(1),
    })
    .readonly();

export type SessionRecordingTurnAttempt = z.infer<typeof sessionRecordingTurnAttemptSchema>;
export type SessionRecordingTurnPrompt = z.infer<typeof sessionRecordingTurnPromptSchema>;
export type SessionRecordingTurnItem = z.infer<typeof sessionRecordingTurnItemSchema>;
export type SessionRecordingTurn = z.infer<typeof sessionRecordingTurnSchema>;
export type SessionRecordingInteraction = z.infer<typeof sessionRecordingInteractionSchema>;
export type SessionRecordingTurnPage = z.infer<typeof sessionRecordingTurnPageSchema>;
export type SessionRecordingTurnItemPage = z.infer<typeof sessionRecordingTurnItemPageSchema>;
export type SessionRecordingTurnItemDetail = z.infer<typeof sessionRecordingTurnItemDetailSchema>;

function decode<T>(encoded: string, schema: z.ZodType<T>): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid Session Recording message", { cause });
    }
}

export const decodeSessionRecordingTurnPage = (encoded: string): SessionRecordingTurnPage =>
    decode(encoded, sessionRecordingTurnPageSchema);

export const encodeSessionRecordingTurnPage = (value: SessionRecordingTurnPage): string =>
    JSON.stringify(sessionRecordingTurnPageSchema.parse(value));

export const decodeSessionRecordingTurnItemPage = (encoded: string): SessionRecordingTurnItemPage =>
    decode(encoded, sessionRecordingTurnItemPageSchema);

export const encodeSessionRecordingTurnItemPage = (value: SessionRecordingTurnItemPage): string =>
    JSON.stringify(sessionRecordingTurnItemPageSchema.parse(value));

export const decodeSessionRecordingTurnItemDetail = (encoded: string): SessionRecordingTurnItemDetail =>
    decode(encoded, sessionRecordingTurnItemDetailSchema);

export const encodeSessionRecordingTurnItemDetail = (value: SessionRecordingTurnItemDetail): string =>
    JSON.stringify(sessionRecordingTurnItemDetailSchema.parse(value));
