import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema } from "./identifier.ts";
import { sessionEventEnvelopeV2Schema, sessionEventV2Schema } from "./session-event-log-v2.ts";
import { sessionLiveEventEnvelopeV3Schema, sessionLiveEventV3Schema } from "./session-v3.ts";

const sessionRecordingWriteSchema = z
    .object({
        envelope: sessionEventEnvelopeV2Schema,
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
    })
    .readonly();

const sessionRecordingHistorySchema = z
    .object({
        events: z.array(sessionEventV2Schema).max(100_000).readonly(),
        sessionId: identifierStringSchema,
    })
    .readonly();

export const sessionRecordingStatusSchema = z.enum(["running", "idle", "failed"]);

// Recording cursors are opaque append-order tokens. The ordinal locates a recorded batch and the
// position locates an event inside that batch; event positions alone restart after a Session reload.
const recordingCursorSchema = z.string().regex(/^v2:[1-9][0-9]*:(?:0|[1-9][0-9]*)$/);

const sessionRecordingHistoryPageSchema = z
    .object({
        events: z.array(sessionEventV2Schema).max(10_000).readonly(),
        // The append-order cursor after this page, or null when the caller has caught up.
        nextCursor: recordingCursorSchema.nullable(),
        // The append-order cursor at the newest recorded event, so an idle poller can compare one token.
        tailCursor: recordingCursorSchema,
        // True when a Session generation changed after the caller's cursor and it must replace its
        // reconstructed state rather than append this page.
        generationReset: z.boolean(),
        sessionId: identifierStringSchema,
        truncated: z.boolean(),
        version: z.literal(2),
    })
    .readonly();

const sessionRecordingSummarySchema = z
    .object({
        additionalDirectoryIds: z.array(identifierStringSchema).max(16).readonly(),
        agentId: identifierStringSchema,
        directoryId: z.string().min(1).max(2_048),
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
        status: sessionRecordingStatusSchema,
        title: z.string().max(1_000),
        updatedAt: z.iso.datetime({ offset: true }),
    })
    .readonly();

const sessionRecordingDirectorySchema = z
    .object({
        sessions: z.array(sessionRecordingSummarySchema).max(100_000).readonly(),
    })
    .readonly();

const recordedAtSchema = z.iso.datetime({ offset: true });
const sessionRecordingWriteV3Schema = z
    .strictObject({
        envelope: sessionLiveEventEnvelopeV3Schema,
        projectId: identifierStringSchema,
        recordedAt: recordedAtSchema,
        runtimeId: identifierStringSchema,
    })
    .superRefine((write, context) => {
        const sessionId = write.envelope.events[0]?.sessionId;
        if (sessionId === undefined) {
            context.addIssue({ code: "custom", message: "A V3 recording write must contain an event" });
            return;
        }
        if (write.envelope.events.some((event) => event.sessionId !== sessionId)) {
            context.addIssue({ code: "custom", message: "A V3 recording write must target one Session" });
        }
    })
    .readonly();
const recordedSessionLiveEventV3Schema = z
    .strictObject({ event: sessionLiveEventV3Schema, recordedAt: recordedAtSchema })
    .readonly();
const sessionRecordingGapV3Schema = z
    .strictObject({
        fromSeq: z.number().int().positive().safe(),
        toSeq: z.number().int().positive().safe(),
    })
    .refine((gap) => gap.fromSeq <= gap.toSeq, { message: "A V3 recording gap must be ordered" })
    .readonly();
export const sessionRecordingContinuityV3Schema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("complete") }).readonly(),
    z.strictObject({ firstMissingSeq: z.number().int().positive().safe(), kind: z.literal("incomplete") }).readonly(),
]);
const sessionRecordingPageV3Schema = z
    .strictObject({
        events: z.array(recordedSessionLiveEventV3Schema).max(10_000).readonly(),
        gaps: z.array(sessionRecordingGapV3Schema).max(10_000).readonly(),
        nextCursor: z.number().int().positive().safe().nullable(),
        sessionId: identifierStringSchema,
        tailSeq: z.number().int().nonnegative().safe(),
        version: z.literal(3),
    })
    .superRefine((page, context) => {
        if (page.events.some(({ event }) => event.sessionId !== page.sessionId || event.seq > page.tailSeq)) {
            context.addIssue({ code: "custom", message: "A V3 recording page contains an invalid Session event" });
        }
        const last = page.events.at(-1)?.event.seq ?? null;
        if (page.nextCursor !== last) {
            context.addIssue({ code: "custom", message: "A V3 recording cursor must identify the last page event" });
        }
    })
    .readonly();

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingHistoryPage = z.infer<typeof sessionRecordingHistoryPageSchema>;
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
export type SessionRecordingStatus = z.infer<typeof sessionRecordingStatusSchema>;
export type SessionRecordingDirectory = z.infer<typeof sessionRecordingDirectorySchema>;
export type SessionRecordingWriteV3 = z.infer<typeof sessionRecordingWriteV3Schema>;
export type RecordedSessionLiveEventV3 = z.infer<typeof recordedSessionLiveEventV3Schema>;
export type SessionRecordingGapV3 = z.infer<typeof sessionRecordingGapV3Schema>;
export type SessionRecordingContinuityV3 = z.infer<typeof sessionRecordingContinuityV3Schema>;
export type SessionRecordingPageV3 = z.infer<typeof sessionRecordingPageV3Schema>;

function decode<T>(encoded: string, schema: z.ZodType<T>): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid Session Recording message", { cause });
    }
}

export const decodeSessionRecordingWrite = (encoded: string): SessionRecordingWrite =>
    decode(encoded, sessionRecordingWriteSchema);

export const encodeSessionRecordingWrite = (value: SessionRecordingWrite): string =>
    JSON.stringify(sessionRecordingWriteSchema.parse(value));

export const decodeSessionRecordingHistory = (encoded: string): SessionRecordingHistory =>
    decode(encoded, sessionRecordingHistorySchema);

export const encodeSessionRecordingHistory = (value: SessionRecordingHistory): string =>
    JSON.stringify(sessionRecordingHistorySchema.parse(value));

export const decodeSessionRecordingHistoryPage = (encoded: string): SessionRecordingHistoryPage =>
    decode(encoded, sessionRecordingHistoryPageSchema);

export const encodeSessionRecordingHistoryPage = (value: SessionRecordingHistoryPage): string =>
    JSON.stringify(sessionRecordingHistoryPageSchema.parse(value));

export const decodeSessionRecordingDirectory = (encoded: string): SessionRecordingDirectory =>
    decode(encoded, sessionRecordingDirectorySchema);

export const encodeSessionRecordingDirectory = (value: SessionRecordingDirectory): string =>
    JSON.stringify(sessionRecordingDirectorySchema.parse(value));

export const decodeSessionRecordingWriteV3 = (encoded: string): SessionRecordingWriteV3 =>
    decode(encoded, sessionRecordingWriteV3Schema);

export const encodeSessionRecordingWriteV3 = (value: SessionRecordingWriteV3): string =>
    JSON.stringify(sessionRecordingWriteV3Schema.parse(value));

export const decodeSessionRecordingPageV3 = (encoded: string): SessionRecordingPageV3 =>
    decode(encoded, sessionRecordingPageV3Schema);

export const encodeSessionRecordingPageV3 = (value: SessionRecordingPageV3): string =>
    JSON.stringify(sessionRecordingPageV3Schema.parse(value));
