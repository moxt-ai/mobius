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

const sessionRecordingTargetSchema = z
    .object({
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
    })
    .readonly();

const sessionRecordingDirectorySchema = z
    .object({
        nextCursor: z.string().min(1).max(512).nullable().optional(),
        sessions: z.array(sessionRecordingSummarySchema).max(100_000).readonly(),
        truncated: z.boolean().optional(),
    })
    .readonly();

const sessionRecordingIntegritySchema = z.discriminatedUnion("kind", [
    z
        .object({
            eventCount: z.number().int().positive().safe(),
            expectedEventCount: z.number().int().positive().safe(),
            firstPosition: recordingPositionSchema,
            kind: z.literal("complete"),
            lastPosition: recordingPositionSchema,
            missingPositionCount: z.literal(0),
            missingPositions: z.array(recordingPositionSchema).readonly(),
            missingPositionsTruncated: z.literal(false),
        })
        .readonly(),
    z
        .object({
            eventCount: z.number().int().positive().safe(),
            expectedEventCount: z.number().int().positive().safe(),
            firstPosition: recordingPositionSchema,
            kind: z.literal("partial"),
            lastPosition: recordingPositionSchema,
            missingPositionCount: z.number().int().positive().safe(),
            missingPositions: z.array(recordingPositionSchema).max(1_000).readonly(),
            missingPositionsTruncated: z.boolean(),
        })
        .readonly(),
]);

const sessionRecordingRetentionSchema = z.discriminatedUnion("kind", [
    z
        .object({
            configuredAt: z.iso.datetime({ offset: true }),
            expiresAt: z.iso.datetime({ offset: true }),
            kind: z.literal("managed"),
            retentionMilliseconds: z.number().int().positive().safe(),
        })
        .readonly(),
    z.object({ kind: z.literal("unmanaged") }).readonly(),
]);

const sessionRecordingDeliverySchema = z.discriminatedUnion("kind", [
    z
        .object({
            expectedEventCount: z.number().int().nonnegative().safe(),
            firstDeliveredAt: z.iso.datetime({ offset: true }),
            kind: z.literal("recorded"),
            lastDeliveredAt: z.iso.datetime({ offset: true }),
            missingEventCount: z.number().int().nonnegative().safe(),
            recordedEventCount: z.number().int().positive().safe(),
        })
        .readonly(),
    z.object({ kind: z.literal("unobserved") }).readonly(),
]);

const sessionRecordingStateSchema = z
    .object({
        delivery: sessionRecordingDeliverySchema,
        integrity: sessionRecordingIntegritySchema,
        retention: sessionRecordingRetentionSchema,
        state: z.literal("available"),
    })
    .readonly();

const sessionRecordingMetadataSchema = z
    .object({
        projectId: identifierStringSchema,
        recording: sessionRecordingStateSchema,
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
        summary: sessionRecordingSummarySchema.nullable(),
    })
    .readonly();

const historySourceStateSchema = z.enum(["available", "disabled", "partial", "unavailable", "unknown"]);

const sessionHistorySourceSchema = z
    .object({
        detail: z.string().max(500).nullable().optional(),
        kind: z.enum(["native", "recording", "runtime-live"]),
        state: historySourceStateSchema,
    })
    .readonly();

const sessionHistorySourcesSchema = z
    .object({
        projectId: identifierStringSchema,
        recommended: z.enum(["native", "recording", "runtime-live", "none"]),
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
        sources: z.array(sessionHistorySourceSchema).min(3).max(3).readonly(),
    })
    .readonly();

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingHistoryPage = z.infer<typeof sessionRecordingHistoryPageSchema>;
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
export type SessionRecordingStatus = z.infer<typeof sessionRecordingStatusSchema>;
export type SessionRecordingDirectory = z.infer<typeof sessionRecordingDirectorySchema>;
export type SessionRecordingTarget = z.infer<typeof sessionRecordingTargetSchema>;
export type SessionRecordingIntegrity = z.infer<typeof sessionRecordingIntegritySchema>;
export type SessionRecordingRetention = z.infer<typeof sessionRecordingRetentionSchema>;
export type SessionRecordingDelivery = z.infer<typeof sessionRecordingDeliverySchema>;
export type SessionRecordingState = z.infer<typeof sessionRecordingStateSchema>;
export type SessionRecordingMetadata = z.infer<typeof sessionRecordingMetadataSchema>;
export type SessionHistorySource = z.infer<typeof sessionHistorySourceSchema>;
export type SessionHistorySources = z.infer<typeof sessionHistorySourcesSchema>;

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

export const decodeSessionRecordingTarget = (encoded: string): SessionRecordingTarget =>
    decode(encoded, sessionRecordingTargetSchema);

export const encodeSessionRecordingTarget = (value: SessionRecordingTarget): string =>
    JSON.stringify(sessionRecordingTargetSchema.parse(value));

export const decodeSessionRecordingIntegrity = (encoded: string): SessionRecordingIntegrity =>
    decode(encoded, sessionRecordingIntegritySchema);

export const encodeSessionRecordingIntegrity = (value: SessionRecordingIntegrity): string =>
    JSON.stringify(sessionRecordingIntegritySchema.parse(value));

export const decodeSessionRecordingRetention = (encoded: string): SessionRecordingRetention =>
    decode(encoded, sessionRecordingRetentionSchema);

export const encodeSessionRecordingRetention = (value: SessionRecordingRetention): string =>
    JSON.stringify(sessionRecordingRetentionSchema.parse(value));

export const decodeSessionRecordingDelivery = (encoded: string): SessionRecordingDelivery =>
    decode(encoded, sessionRecordingDeliverySchema);

export const encodeSessionRecordingDelivery = (value: SessionRecordingDelivery): string =>
    JSON.stringify(sessionRecordingDeliverySchema.parse(value));

export const decodeSessionRecordingMetadata = (encoded: string): SessionRecordingMetadata =>
    decode(encoded, sessionRecordingMetadataSchema);

export const encodeSessionRecordingMetadata = (value: SessionRecordingMetadata): string =>
    JSON.stringify(sessionRecordingMetadataSchema.parse(value));

export const decodeSessionHistorySources = (encoded: string): SessionHistorySources =>
    decode(encoded, sessionHistorySourcesSchema);

export const encodeSessionHistorySources = (value: SessionHistorySources): string =>
    JSON.stringify(sessionHistorySourcesSchema.parse(value));
