import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { sessionHistorySchema } from "./session-history.ts";

export const SESSION_LIVE_HISTORY_LOAD_KIND = "session.live-history.load";
export const SESSION_LIVE_HISTORY_LOADED_KIND = "session.live-history.loaded";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
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

export type SessionLiveHistoryLoad = z.infer<typeof sessionLiveHistoryLoadSchema>;
export type SessionLiveHistoryLoaded = z.infer<typeof sessionLiveHistoryLoadedSchema>;

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
