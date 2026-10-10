import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";
import { nativeSessionEventsV2Schema } from "./session-event-log-v2.ts";

export const SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND = "session.live-history.v2.page.load";
export const SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND = "session.live-history.v2.page.loaded";
export const SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND = "session.preview-history.page.load";
export const SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND = "session.preview-history.page.loaded";

const directoryIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);

const pageRequestFields = {
    cursor: z.string().min(1).max(512).nullable(),
    eventLimit: z.number().int().min(1).max(10_000),
    requestId: identifier,
    sessionId: identifier,
};

const sessionLiveHistoryV2PageLoadSchema = z
    .object({ ...pageRequestFields, kind: z.literal(SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND) })
    .readonly();

const sessionPreviewHistoryPageLoadSchema = z
    .object({
        ...pageRequestFields,
        additionalDirectoryIds: z.array(directoryIdentifier).max(16).readonly(),
        agentId: identifier,
        bindingId: identifier,
        directoryId: directoryIdentifier,
        kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND),
    })
    .readonly();

const pageLoadedFields = {
    events: nativeSessionEventsV2Schema,
    requestId: identifier,
    sessionId: identifier,
};

const sessionLiveHistoryV2PageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND) })
    .readonly();

const sessionPreviewHistoryPageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) })
    .readonly();

export type SessionLiveHistoryV2PageLoad = z.infer<typeof sessionLiveHistoryV2PageLoadSchema>;
export type SessionLiveHistoryV2PageLoaded = z.infer<typeof sessionLiveHistoryV2PageLoadedSchema>;
export type SessionPreviewHistoryPageLoad = z.infer<typeof sessionPreviewHistoryPageLoadSchema>;
export type SessionPreviewHistoryPageLoaded = z.infer<typeof sessionPreviewHistoryPageLoadedSchema>;

function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid live Session history message", { cause });
    }
}

export const decodeSessionLiveHistoryV2PageLoad = (encoded: string): SessionLiveHistoryV2PageLoad =>
    decode(sessionLiveHistoryV2PageLoadSchema, encoded);
export const decodeSessionLiveHistoryV2PageLoaded = (encoded: string): SessionLiveHistoryV2PageLoaded =>
    decode(sessionLiveHistoryV2PageLoadedSchema, encoded);
export const decodeSessionPreviewHistoryPageLoad = (encoded: string): SessionPreviewHistoryPageLoad =>
    decode(sessionPreviewHistoryPageLoadSchema, encoded);
export const decodeSessionPreviewHistoryPageLoaded = (encoded: string): SessionPreviewHistoryPageLoaded =>
    decode(sessionPreviewHistoryPageLoadedSchema, encoded);
export const encodeSessionLiveHistoryV2PageLoad = (value: SessionLiveHistoryV2PageLoad): string =>
    JSON.stringify(sessionLiveHistoryV2PageLoadSchema.parse(value));
export const encodeSessionLiveHistoryV2PageLoaded = (value: SessionLiveHistoryV2PageLoaded): string =>
    JSON.stringify(sessionLiveHistoryV2PageLoadedSchema.parse(value));
export const encodeSessionPreviewHistoryPageLoad = (value: SessionPreviewHistoryPageLoad): string =>
    JSON.stringify(sessionPreviewHistoryPageLoadSchema.parse(value));
export const encodeSessionPreviewHistoryPageLoaded = (value: SessionPreviewHistoryPageLoaded): string =>
    JSON.stringify(sessionPreviewHistoryPageLoadedSchema.parse(value));
