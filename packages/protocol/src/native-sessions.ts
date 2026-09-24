import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { sessionCapabilitiesSchema, sessionReadyEventSchema } from "./control-messages.ts";
import { sessionHistorySchema } from "./session-history.ts";

export const NATIVE_SESSION_REQUEST_KIND = "native.session.request";
export const NATIVE_SESSION_RESULT_KIND = "native.session.result";
export const NATIVE_SESSION_CANCEL_KIND = "native.session.cancel";
export const NATIVE_SESSION_TURN_FORK_REQUEST_KIND = "native.session.turn-fork.request";
export const NATIVE_SESSION_TURN_FORK_KIND = "native.session.turn-fork";
export const ACTIVE_TURN_TEXT_LIMIT = 1_000_000;

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const directoryId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);
const envelope = {
    requestId: identifier,
    sessionId: identifier,
};
const identity = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
    additionalDirectoryIds: z.array(directoryId).max(16).readonly(),
    agentId: identifier,
    bindingId: identifier,
    directoryId,
};

const turnForkIdentity = {
    additionalDirectoryIds: z.array(directoryId).max(16).readonly(),
    agentId: identifier,
    bindingId: identifier,
    directoryId,
    requestId: identifier,
    sessionId: identifier,
    sourceCommandId: identifier,
    targetSessionId: identifier,
};

const nativeSessionTurnForkRequestSchema = z
    .strictObject({
        ...turnForkIdentity,
        kind: z.literal(NATIVE_SESSION_TURN_FORK_REQUEST_KIND),
    })
    .readonly();
export type NativeSessionTurnForkRequest = z.infer<typeof nativeSessionTurnForkRequestSchema>;

const nativeSessionTurnForkCommandSchema = z
    .strictObject({
        ...turnForkIdentity,
        kind: z.literal(NATIVE_SESSION_TURN_FORK_KIND),
        messageFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        messageId: z.string().min(1).max(255),
        messageOccurrence: z.number().int().positive(),
        title: z.string().max(500),
    })
    .readonly();
export type NativeSessionTurnForkCommand = z.infer<typeof nativeSessionTurnForkCommandSchema>;

const nativeSessionRequestSchema = z.discriminatedUnion("action", [
    z.strictObject({ ...identity, action: z.literal("create") }).readonly(),
    z.strictObject({ ...identity, action: z.literal("active-turn"), targetSessionId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("preview"), entryId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("history"), entryId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .strictObject({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .strictObject({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
    z
        .strictObject({
            ...identity,
            action: z.literal("delete"),
            entryId: identifier,
        })
        .readonly(),
]);
export type NativeSessionRequest = z.infer<typeof nativeSessionRequestSchema>;
const nativeSessionCommandSchema = z.discriminatedUnion("action", [
    z.strictObject({ ...identity, action: z.literal("create") }).readonly(),
    z.strictObject({ ...identity, action: z.literal("active-turn"), targetSessionId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("preview"), entryId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("history"), entryId: identifier }).readonly(),
    z.strictObject({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .strictObject({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .strictObject({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
    z
        .strictObject({
            ...identity,
            action: z.literal("delete"),
            entryId: identifier,
        })
        .readonly(),
]);
export type NativeSessionCommand = z.infer<typeof nativeSessionCommandSchema>;

const nativeSessionEntrySchema = z
    .strictObject({
        entryId: identifier,
        mobiusSessionIds: z.array(identifier).max(500).readonly(),
        nativeSessionId: identifier,
        title: z.string().max(500),
        directoryId,
        directoryLabel: z.string().min(1).max(2_048),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
        additionalDirectories: z
            .array(z.strictObject({ directoryId, name: z.string().min(1).max(255) }).readonly())
            .max(16)
            .readonly(),
    })
    .readonly();
export type NativeSessionEntry = z.infer<typeof nativeSessionEntrySchema>;

const resultEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_RESULT_KIND),
};
const nativeSessionResultSchema = z.discriminatedUnion("action", [
    z.strictObject({ ...resultEnvelope, action: z.literal("create"), nativeSessionId: identifier }).readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("active-turn"),
            targetSessionId: identifier,
            turn: z
                .strictObject({
                    commandId: identifier,
                    prompt: z.string().max(100_000),
                    text: z.string().max(ACTIVE_TURN_TEXT_LIMIT),
                    truncated: z.boolean(),
                    epoch: identifier,
                    sequence: z.number().int().nonnegative(),
                    state: z.literal("running"),
                })
                .readonly()
                .nullable(),
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("find"),
            entry: nativeSessionEntrySchema,
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("list"),
            capabilities: sessionCapabilitiesSchema,
            entries: z.array(nativeSessionEntrySchema).max(500).readonly(),
            nextCursor: identifier.nullable(),
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.enum(["import", "fork"]),
            targetSessionId: identifier,
            ready: sessionReadyEventSchema,
            title: z.string().max(500),
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("preview"),
            entryId: identifier,
            targetSessionId: identifier,
            reason: z.enum(["continuation_unavailable", "requested"]),
            history: sessionHistorySchema,
            title: z.string().max(500),
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("history"),
            entryId: identifier,
            history: sessionHistorySchema,
            title: z.string().max(500),
        })
        .readonly(),
    z
        .strictObject({
            ...resultEnvelope,
            action: z.literal("delete"),
            entryId: identifier,
            deletedSessionIds: z.array(identifier).max(500).readonly(),
        })
        .readonly(),
]);
export type NativeSessionResult = z.infer<typeof nativeSessionResultSchema>;

const nativeSessionCancelSchema = z
    .strictObject({ ...envelope, kind: z.literal(NATIVE_SESSION_CANCEL_KIND) })
    .readonly();
export type NativeSessionCancel = z.infer<typeof nativeSessionCancelSchema>;
function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session message", { cause });
    }
}

export const decodeNativeSessionCommand = (encoded: string): NativeSessionCommand =>
    decode(nativeSessionCommandSchema, encoded);
export const encodeNativeSessionCommand = (value: NativeSessionCommand): string =>
    JSON.stringify(nativeSessionCommandSchema.parse(value));
export const decodeNativeSessionRequest = (encoded: string): NativeSessionRequest =>
    decode(nativeSessionRequestSchema, encoded);
export const encodeNativeSessionRequest = (value: NativeSessionRequest): string =>
    JSON.stringify(nativeSessionRequestSchema.parse(value));
export const decodeNativeSessionResult = (encoded: string): NativeSessionResult =>
    decode(nativeSessionResultSchema, encoded);
export const encodeNativeSessionResult = (value: NativeSessionResult): string =>
    JSON.stringify(nativeSessionResultSchema.parse(value));
export const decodeNativeSessionCancel = (encoded: string): NativeSessionCancel =>
    decode(nativeSessionCancelSchema, encoded);
export const encodeNativeSessionCancel = (value: NativeSessionCancel): string =>
    JSON.stringify(nativeSessionCancelSchema.parse(value));
export const decodeNativeSessionTurnForkRequest = (encoded: string): NativeSessionTurnForkRequest =>
    decode(nativeSessionTurnForkRequestSchema, encoded);
export const encodeNativeSessionTurnForkRequest = (value: NativeSessionTurnForkRequest): string =>
    JSON.stringify(nativeSessionTurnForkRequestSchema.parse(value));
export const decodeNativeSessionTurnForkCommand = (encoded: string): NativeSessionTurnForkCommand =>
    decode(nativeSessionTurnForkCommandSchema, encoded);
export const encodeNativeSessionTurnForkCommand = (value: NativeSessionTurnForkCommand): string =>
    JSON.stringify(nativeSessionTurnForkCommandSchema.parse(value));
