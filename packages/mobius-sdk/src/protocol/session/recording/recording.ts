import { z } from "zod";
import { DIRECTORY_IDENTIFIER } from "../../shared/directory.ts";

import { identifierStringSchema } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { sessionEventEnvelopeSchema, sessionLiveEventSchema, sessionWireEnvelopeSchema } from "../events/index.ts";

/** An optional event-read wait budget is bounded independently of the page's event budget. */
export function parseSessionRecordingWaitMilliseconds(value: string): number | null {
    if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) {
        return null;
    }
    const milliseconds = Number(value);
    return milliseconds <= 10_000 ? milliseconds : null;
}

const sessionRecordingWriteSchema = z
    .object({
        envelope: sessionEventEnvelopeSchema,
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
    })
    .readonly();

const sessionRecordingWireWriteSchema = z
    .object({
        envelope: sessionWireEnvelopeSchema,
        projectId: identifierStringSchema,
        runtimeId: identifierStringSchema,
    })
    .readonly();
export type SessionRecordingWireWrite = z.infer<typeof sessionRecordingWireWriteSchema>;
export const decodeSessionRecordingWireWrite = (encoded: string): SessionRecordingWireWrite =>
    decode(encoded, sessionRecordingWireWriteSchema);
export const encodeSessionRecordingWireWrite = (value: SessionRecordingWireWrite): string =>
    encode(value, sessionRecordingWireWriteSchema);

// Full history is serialized straight from storage rather than through encodeSessionRecordingHistory,
// so an event cap here never bounded what a Durable Object emitted. It only rejected the reader after
// the payload was already parsed, turning a long Session into a hard failure. Bounded reads use pages.
const sessionRecordingHistorySchema = z
    .object({
        events: z.array(sessionLiveEventSchema).readonly(),
        sessionId: identifierStringSchema,
    })
    .readonly();

/** Legacy lifecycle observations from recorded events; never authoritative execution state. */
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

const sessionRecordingSummaryFields = {
    additionalDirectoryIds: z.array(DIRECTORY_IDENTIFIER).max(16).readonly(),
    agentId: identifierStringSchema,
    directoryId: DIRECTORY_IDENTIFIER,
    runtimeId: identifierStringSchema,
    sessionId: identifierStringSchema,
    title: z.string().max(1_000),
    updatedAt: z.iso.datetime({ offset: true }),
};

const sessionRecordingSummaryV2Schema = z.object(sessionRecordingSummaryFields).readonly();
const sessionRecordingDirectoryV2Schema = z
    .object({ sessions: z.array(sessionRecordingSummaryV2Schema).max(100_000).readonly() })
    .readonly();

// Preserve the V1 wire contract for existing SDKs while V2 carries metadata only.
const sessionRecordingSummarySchema = z
    .object({ ...sessionRecordingSummaryFields, status: sessionRecordingStatusSchema })
    .readonly();

const sessionRecordingDirectorySchema = z
    .object({
        sessions: z.array(sessionRecordingSummarySchema).max(100_000).readonly(),
    })
    .readonly();

export type SessionRecordingWrite = z.infer<typeof sessionRecordingWriteSchema>;
export type SessionRecordingHistory = z.infer<typeof sessionRecordingHistorySchema>;
export type SessionRecordingHistoryPage = z.infer<typeof sessionRecordingHistoryPageSchema>;
/** @deprecated Use SessionRecordingSummaryV2; query the daemon for current execution state. */
export type SessionRecordingSummary = z.infer<typeof sessionRecordingSummarySchema>;
export type SessionRecordingStatus = z.infer<typeof sessionRecordingStatusSchema>;
/** @deprecated Use SessionRecordingDirectoryV2 with the V2 Recording summary endpoints. */
export type SessionRecordingDirectory = z.infer<typeof sessionRecordingDirectorySchema>;
export type SessionRecordingSummaryV2 = z.infer<typeof sessionRecordingSummaryV2Schema>;
export type SessionRecordingDirectoryV2 = z.infer<typeof sessionRecordingDirectoryV2Schema>;

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

/** @deprecated Use decodeSessionRecordingDirectoryV2 with the V2 Recording summary endpoints. */
export const decodeSessionRecordingDirectory = (encoded: string): SessionRecordingDirectory =>
    decode(encoded, sessionRecordingDirectorySchema);

export const encodeSessionRecordingDirectory = (value: SessionRecordingDirectory): string =>
    encode(value, sessionRecordingDirectorySchema);

export const decodeSessionRecordingSummaryV2 = (encoded: string): SessionRecordingSummaryV2 =>
    decode(encoded, sessionRecordingSummaryV2Schema);

export const decodeSessionRecordingDirectoryV2 = (encoded: string): SessionRecordingDirectoryV2 =>
    decode(encoded, sessionRecordingDirectoryV2Schema);

export const encodeSessionRecordingDirectoryV2 = (value: SessionRecordingDirectoryV2): string =>
    encode(value, sessionRecordingDirectoryV2Schema);
