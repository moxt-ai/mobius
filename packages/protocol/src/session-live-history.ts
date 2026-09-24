import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";
import { nativeMessagePageSchema, sessionHistorySchema } from "./session-history.ts";

export const SESSION_LIVE_HISTORY_LOAD_KIND = "session.live-history.load";
export const SESSION_LIVE_HISTORY_LOADED_KIND = "session.live-history.loaded";
export const SESSION_LIVE_HISTORY_PAGE_LOAD_KIND = "session.live-history.page.load";
export const SESSION_LIVE_HISTORY_PAGE_LOADED_KIND = "session.live-history.page.loaded";

const directoryIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);

const sessionLiveHistoryLoadSchema = z
    .strictObject({
        additionalDirectoryIds: z.array(directoryIdentifier).max(16).readonly(),
        agentId: identifier,
        bindingId: identifier,
        directoryId: directoryIdentifier,
        kind: z.literal(SESSION_LIVE_HISTORY_LOAD_KIND),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

const sessionLiveHistoryLoadedSchema = z
    .strictObject({
        history: sessionHistorySchema,
        kind: z.literal(SESSION_LIVE_HISTORY_LOADED_KIND),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

const sessionLiveHistoryPageLoadSchema = z
    .strictObject({
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
    .strictObject({
        kind: z.literal(SESSION_LIVE_HISTORY_PAGE_LOADED_KIND),
        page: nativeMessagePageSchema,
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();

export type SessionLiveHistoryLoad = z.infer<typeof sessionLiveHistoryLoadSchema>;
export type SessionLiveHistoryLoaded = z.infer<typeof sessionLiveHistoryLoadedSchema>;
export type SessionLiveHistoryPageLoad = z.infer<typeof sessionLiveHistoryPageLoadSchema>;
export type SessionLiveHistoryPageLoaded = z.infer<typeof sessionLiveHistoryPageLoadedSchema>;

function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid live Session history message", { cause });
    }
}

export const decodeSessionLiveHistoryLoad = (encoded: string): SessionLiveHistoryLoad =>
    decode(sessionLiveHistoryLoadSchema, encoded);
export const decodeSessionLiveHistoryLoaded = (encoded: string): SessionLiveHistoryLoaded =>
    decode(sessionLiveHistoryLoadedSchema, encoded);
export const encodeSessionLiveHistoryLoad = (value: SessionLiveHistoryLoad): string =>
    JSON.stringify(sessionLiveHistoryLoadSchema.parse(value));
export const encodeSessionLiveHistoryLoaded = (value: SessionLiveHistoryLoaded): string =>
    JSON.stringify(sessionLiveHistoryLoadedSchema.parse(value));
export const decodeSessionLiveHistoryPageLoad = (encoded: string): SessionLiveHistoryPageLoad =>
    decode(sessionLiveHistoryPageLoadSchema, encoded);
export const decodeSessionLiveHistoryPageLoaded = (encoded: string): SessionLiveHistoryPageLoaded =>
    decode(sessionLiveHistoryPageLoadedSchema, encoded);
export const encodeSessionLiveHistoryPageLoad = (value: SessionLiveHistoryPageLoad): string =>
    JSON.stringify(sessionLiveHistoryPageLoadSchema.parse(value));
export const encodeSessionLiveHistoryPageLoaded = (value: SessionLiveHistoryPageLoaded): string =>
    JSON.stringify(sessionLiveHistoryPageLoadedSchema.parse(value));
