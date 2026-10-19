import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";
import { nativeSessionEventsSchema, sessionEventOmissionSchema } from "./session-event-log.ts";

export const SESSION_LIVE_HISTORY_PAGE_LOAD_KIND = "session.live-history.v2.page.load";
export const SESSION_LIVE_HISTORY_PAGE_LOADED_KIND = "session.live-history.v2.page.loaded";
export const SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND = "session.preview-history.page.load";
export const SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND = "session.preview-history.page.loaded";

const directoryIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);

const pageRequestFields = {
    cursor: z.string().min(1).max(512).nullable(),
    eventLimit: z.number().int().min(1).max(10_000),
    omit: z.array(sessionEventOmissionSchema).max(1).readonly().optional(),
    requestId: identifier,
    sessionId: identifier,
};

const sessionLiveHistoryPageLoadSchema = z
    .object({ ...pageRequestFields, kind: z.literal(SESSION_LIVE_HISTORY_PAGE_LOAD_KIND) })
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
    events: nativeSessionEventsSchema,
    requestId: identifier,
    sessionId: identifier,
};

const sessionLiveHistoryPageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_LIVE_HISTORY_PAGE_LOADED_KIND) })
    .readonly();

const sessionPreviewHistoryPageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) })
    .readonly();

export type SessionLiveHistoryPageLoad = z.infer<typeof sessionLiveHistoryPageLoadSchema>;
export type SessionLiveHistoryPageLoaded = z.infer<typeof sessionLiveHistoryPageLoadedSchema>;
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

export const decodeSessionLiveHistoryPageLoad = (encoded: string): SessionLiveHistoryPageLoad =>
    decode(sessionLiveHistoryPageLoadSchema, encoded);
export const decodeSessionLiveHistoryPageLoaded = (encoded: string): SessionLiveHistoryPageLoaded =>
    decode(sessionLiveHistoryPageLoadedSchema, encoded);
export const decodeSessionPreviewHistoryPageLoad = (encoded: string): SessionPreviewHistoryPageLoad =>
    decode(sessionPreviewHistoryPageLoadSchema, encoded);
export const decodeSessionPreviewHistoryPageLoaded = (encoded: string): SessionPreviewHistoryPageLoaded =>
    decode(sessionPreviewHistoryPageLoadedSchema, encoded);
export const encodeSessionLiveHistoryPageLoad = (value: SessionLiveHistoryPageLoad): string =>
    JSON.stringify(sessionLiveHistoryPageLoadSchema.parse(value));
export const encodeSessionLiveHistoryPageLoaded = (value: SessionLiveHistoryPageLoaded): string =>
    JSON.stringify(sessionLiveHistoryPageLoadedSchema.parse(value));
export const encodeSessionPreviewHistoryPageLoad = (value: SessionPreviewHistoryPageLoad): string =>
    JSON.stringify(sessionPreviewHistoryPageLoadSchema.parse(value));
export const encodeSessionPreviewHistoryPageLoaded = (value: SessionPreviewHistoryPageLoaded): string =>
    JSON.stringify(sessionPreviewHistoryPageLoadedSchema.parse(value));
