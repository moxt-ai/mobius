import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";
import { nativeSessionEventsV2Schema } from "./session-event-log-v2.ts";
import { nativeMessagePageSchema } from "./session-history.ts";

export const SESSION_LIVE_HISTORY_PAGE_LOAD_KIND = "session.live-history.page.load";
export const SESSION_LIVE_HISTORY_PAGE_LOADED_KIND = "session.live-history.page.loaded";
export const SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND = "session.live-history.v2.page.load";
export const SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND = "session.live-history.v2.page.loaded";

const directoryIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);

const sessionLiveHistoryPageLoadSchema = z
    .object({
        additionalDirectoryIds: z.array(directoryIdentifier).max(16).readonly(),
        agentId: identifier,
        bindingId: identifier,
        cursor: z.string().min(1).max(512).nullable(),
        directoryId: directoryIdentifier,
        kind: z.literal(SESSION_LIVE_HISTORY_PAGE_LOAD_KIND),
        limit: z.number().int().min(1).max(100),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

const sessionLiveHistoryPageLoadedSchema = z
    .object({
        kind: z.literal(SESSION_LIVE_HISTORY_PAGE_LOADED_KIND),
        page: nativeMessagePageSchema,
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

const sessionLiveHistoryV2PageLoadSchema = z
    .object({
        additionalDirectoryIds: z.array(directoryIdentifier).max(16).readonly(),
        agentId: identifier,
        bindingId: identifier,
        cursor: z.string().min(1).max(512).nullable(),
        directoryId: directoryIdentifier,
        kind: z.literal(SESSION_LIVE_HISTORY_V2_PAGE_LOAD_KIND),
        eventLimit: z.number().int().min(1).max(10_000),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

const sessionLiveHistoryV2PageLoadedSchema = z
    .object({
        events: nativeSessionEventsV2Schema,
        kind: z.literal(SESSION_LIVE_HISTORY_V2_PAGE_LOADED_KIND),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

export type SessionLiveHistoryPageLoad = z.infer<typeof sessionLiveHistoryPageLoadSchema>;
export type SessionLiveHistoryPageLoaded = z.infer<typeof sessionLiveHistoryPageLoadedSchema>;
export type SessionLiveHistoryV2PageLoad = z.infer<typeof sessionLiveHistoryV2PageLoadSchema>;
export type SessionLiveHistoryV2PageLoaded = z.infer<typeof sessionLiveHistoryV2PageLoadedSchema>;

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
export const encodeSessionLiveHistoryPageLoad = (value: SessionLiveHistoryPageLoad): string =>
    JSON.stringify(sessionLiveHistoryPageLoadSchema.parse(value));
export const encodeSessionLiveHistoryPageLoaded = (value: SessionLiveHistoryPageLoaded): string =>
    JSON.stringify(sessionLiveHistoryPageLoadedSchema.parse(value));
export const decodeSessionLiveHistoryV2PageLoad = (encoded: string): SessionLiveHistoryV2PageLoad =>
    decode(sessionLiveHistoryV2PageLoadSchema, encoded);
export const decodeSessionLiveHistoryV2PageLoaded = (encoded: string): SessionLiveHistoryV2PageLoaded =>
    decode(sessionLiveHistoryV2PageLoadedSchema, encoded);
export const encodeSessionLiveHistoryV2PageLoad = (value: SessionLiveHistoryV2PageLoad): string =>
    JSON.stringify(sessionLiveHistoryV2PageLoadSchema.parse(value));
export const encodeSessionLiveHistoryV2PageLoaded = (value: SessionLiveHistoryV2PageLoaded): string =>
    JSON.stringify(sessionLiveHistoryV2PageLoadedSchema.parse(value));
