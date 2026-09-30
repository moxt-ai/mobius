import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema } from "./identifier.ts";
import { reliableSessionEventEnvelopeSchema } from "./session-events.ts";

const sessionRecordingWriteSchema = z
    .strictObject({
        envelope: reliableSessionEventEnvelopeSchema,
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
    })
    .readonly();

const sessionRecordingEntrySchema = z
    .strictObject({
        envelope: reliableSessionEventEnvelopeSchema,
        recordedAt: z.iso.datetime({ offset: true }),
    })
    .readonly();

const sessionRecordingSegmentSchema = z
    .strictObject({
        entries: z.array(sessionRecordingEntrySchema).max(100_000).readonly(),
        recordingEpoch: identifierStringSchema,
        sessionId: identifierStringSchema,
        throughCommandId: identifierStringSchema.nullable(),
    })
    .readonly();

const sessionRecordingHistorySchema = z
    .strictObject({
        segments: z.array(sessionRecordingSegmentSchema).min(1).max(32).readonly(),
        sessionId: identifierStringSchema,
    })
    .readonly();

const sessionRecordingSummarySchema = z
    .strictObject({
        additionalDirectoryIds: z.array(identifierStringSchema).max(16).readonly(),
        agentId: identifierStringSchema,
        directoryId: z.string().min(1).max(2_048),
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
        title: z.string().max(1_000),
        updatedAt: z.iso.datetime({ offset: true }),
    })
    .readonly();

const sessionRecordingDirectorySchema = z
    .strictObject({
        sessions: z.array(sessionRecordingSummarySchema).max(100_000).readonly(),
    })
    .readonly();

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingEntry = z.infer<typeof sessionRecordingEntrySchema>;
export type SessionRecordingSegment = z.infer<typeof sessionRecordingSegmentSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
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

export const decodeSessionRecordingDirectory = (encoded: string): SessionRecordingDirectory =>
    decode(encoded, sessionRecordingDirectorySchema);

export const encodeSessionRecordingDirectory = (value: SessionRecordingDirectory): string =>
    JSON.stringify(sessionRecordingDirectorySchema.parse(value));
