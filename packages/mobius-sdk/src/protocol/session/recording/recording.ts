import { z } from "zod";

import { identifierStringSchema } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { sessionEventEnvelopeSchema, sessionLiveEventSchema } from "../observability/event-log.ts";

const sessionRecordingWriteSchema = z
    .object({
        envelope: sessionEventEnvelopeSchema,
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
    })
    .readonly();

// Full history is serialized straight from storage rather than through encodeSessionRecordingHistory,
// so an event cap here never bounded what a Durable Object emitted. It only rejected the reader after
// the payload was already parsed, turning a long Session into a hard failure. Bounded reads use pages.
const sessionRecordingHistorySchema = z
    .object({
        events: z.array(sessionLiveEventSchema).readonly(),
        sessionId: identifierStringSchema,
    })
    .readonly();

export const sessionRecordingStatusSchema = z.enum(["running", "idle", "failed"]);

// Recording cursors are opaque append-order tokens. The ordinal locates a recorded batch and the
// position locates an event inside that batch; event positions alone restart after a Session reload.
export const recordingCursorSchema = z.string().regex(/^v2:[1-9][0-9]*:(?:0|[1-9][0-9]*)$/);

const sessionRecordingHistoryPageSchema = z
    .object({
        events: z.array(sessionLiveEventSchema).max(10_000).readonly(),
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

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingHistoryPage = z.infer<typeof sessionRecordingHistoryPageSchema>;
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
export type SessionRecordingStatus = z.infer<typeof sessionRecordingStatusSchema>;
export type SessionRecordingDirectory = z.infer<typeof sessionRecordingDirectorySchema>;

export const decodeSessionRecordingWrite = (encoded: string): SessionRecordingWrite =>
    decode(encoded, sessionRecordingWriteSchema);

export const encodeSessionRecordingWrite = (value: SessionRecordingWrite): string =>
    encode(value, sessionRecordingWriteSchema);

export const decodeSessionRecordingHistory = (encoded: string): SessionRecordingHistory =>
    decode(encoded, sessionRecordingHistorySchema);

export const encodeSessionRecordingHistory = (value: SessionRecordingHistory): string =>
    encode(value, sessionRecordingHistorySchema);

export const decodeSessionRecordingHistoryPage = (encoded: string): SessionRecordingHistoryPage =>
    decode(encoded, sessionRecordingHistoryPageSchema);

export const encodeSessionRecordingHistoryPage = (value: SessionRecordingHistoryPage): string =>
    encode(value, sessionRecordingHistoryPageSchema);

export const decodeSessionRecordingDirectory = (encoded: string): SessionRecordingDirectory =>
    decode(encoded, sessionRecordingDirectorySchema);

export const encodeSessionRecordingDirectory = (value: SessionRecordingDirectory): string =>
    encode(value, sessionRecordingDirectorySchema);
