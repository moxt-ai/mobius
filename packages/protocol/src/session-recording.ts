import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema } from "./identifier.ts";
import { sessionEventEnvelopeV2Schema, sessionEventV2Schema } from "./session-event-log-v2.ts";

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

const recordingPositionSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

const sessionRecordingHistoryPageSchema = z
    .object({
        events: z.array(sessionEventV2Schema).max(10_000).readonly(),
        // The last event position on this page, or null when the caller has caught up.
        nextCursor: recordingPositionSchema.nullable(),
        // The largest recorded position, so a poller can skip decoding entirely while idle.
        tailCursor: recordingPositionSchema,
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

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingHistoryPage = z.infer<typeof sessionRecordingHistoryPageSchema>;
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
export type SessionRecordingStatus = z.infer<typeof sessionRecordingStatusSchema>;
export type SessionRecordingDirectory = z.infer<typeof sessionRecordingDirectorySchema>;

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
