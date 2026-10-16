import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import {
    displayContentSchema,
    promptImageSchema,
    sessionCapabilitiesSchema,
    sessionElicitationRequestedEventSchema,
    sessionPermissionRequestedEventSchema,
    sessionReadyEventSchema,
} from "./control-messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";

export const NATIVE_SESSION_REQUEST_KIND = "native.session.request";
export const NATIVE_SESSION_RESULT_KIND = "native.session.result";
export const NATIVE_SESSION_CANCEL_KIND = "native.session.cancel";

/** Bounding limits for materialized history payloads. */
export const SESSION_HISTORY_CHARACTER_LIMIT = 256_000;
export const SESSION_HISTORY_MESSAGE_LIMIT = 1_000;

const directoryId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);
const envelope = {
    requestId: identifier,
    sessionId: identifier,
};
const activeTurnActivitySchema = z
    .object({
        activityId: z.string().min(1).max(128),
        activityType: z.string().min(1).max(128),
        content: z.array(displayContentSchema).max(100).readonly(),
        input: z.string().max(100_000),
        locations: z.array(z.string().min(1).max(2_048)).max(100).readonly(),
        name: z.string().max(128),
        output: z.string().max(100_000),
        sequence: z.number().int().nonnegative(),
        status: z.string().min(1).max(64),
        title: z.string().max(500),
        toolKind: z.string().max(64),
    })
    .readonly();
const activeTurnUserMessageSchema = z
    .object({
        id: identifier,
        images: z.array(promptImageSchema).max(8).readonly().optional(),
        role: z.literal("user"),
        text: z.string().max(SESSION_HISTORY_CHARACTER_LIMIT),
    })
    .readonly();
const activeTurnAssistantMessageSchema = z
    .object({
        activities: z.array(activeTurnActivitySchema).max(100).readonly().default([]),
        content: z.array(displayContentSchema).max(100).readonly().default([]),
        id: identifier,
        role: z.literal("assistant"),
        text: z.string().max(SESSION_HISTORY_CHARACTER_LIMIT),
    })
    .readonly();
const activeTurnMessageSchema = z.discriminatedUnion("role", [
    activeTurnUserMessageSchema,
    activeTurnAssistantMessageSchema,
]);
export const activeTurnSnapshotSchema = z
    .object({
        commandId: identifier,
        epoch: identifier,
        hasOlder: z.boolean(),
        interaction: z
            .discriminatedUnion("kind", [sessionPermissionRequestedEventSchema, sessionElicitationRequestedEventSchema])
            .nullable(),
        messages: z.array(activeTurnMessageSchema).max(SESSION_HISTORY_MESSAGE_LIMIT).readonly(),
        sequence: z.number().int().nonnegative(),
        state: z.literal("running"),
        truncated: z.boolean(),
    })
    .readonly()
    .refine(
        (snapshot) =>
            snapshot.messages.reduce(
                (total, message) =>
                    total +
                    message.text.length +
                    (message.role === "assistant"
                        ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
                        : 0),
                0,
            ) <= SESSION_HISTORY_CHARACTER_LIMIT,
        "Active Turn snapshot content is too large",
    );
export type ActiveTurnSnapshot = z.infer<typeof activeTurnSnapshotSchema>;
export type ActiveTurnMessage = z.infer<typeof activeTurnMessageSchema>;

const identity = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
    additionalDirectoryIds: z.array(directoryId).max(16).readonly(),
    agentId: identifier,
    bindingId: identifier,
    directoryId,
};

const nativeSessionRequestSchema = z.discriminatedUnion("action", [
    z.object({ ...identity, action: z.literal("active-turn"), targetSessionId: identifier }).readonly(),
    z.object({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .object({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionRequest = z.infer<typeof nativeSessionRequestSchema>;
const nativeSessionCommandSchema = z.discriminatedUnion("action", [
    z.object({ ...identity, action: z.literal("active-turn"), targetSessionId: identifier }).readonly(),
    z.object({ ...identity, action: z.literal("find"), nativeSessionId: identifier }).readonly(),
    z
        .object({
            ...identity,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...identity,
            action: z.enum(["import", "fork"]),
            entryId: identifier,
            targetSessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionCommand = z.infer<typeof nativeSessionCommandSchema>;

const nativeSessionEntrySchema = z
    .object({
        entryId: identifier,
        mobiusSessionIds: z.array(identifier).max(500).readonly(),
        nativeSessionId: identifier,
        title: z.string().max(500),
        directoryId,
        directoryLabel: z.string().min(1).max(2_048),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
        additionalDirectories: z
            .array(z.object({ directoryId, name: z.string().min(1).max(255) }).readonly())
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
    z
        .object({
            ...resultEnvelope,
            action: z.literal("active-turn"),
            targetSessionId: identifier,
            queued: z
                .array(
                    z
                        .object({
                            commandId: identifier,
                            prompt: z.string().max(100_000),
                            images: z.array(promptImageSchema).max(8).readonly(),
                        })
                        .readonly(),
                )
                .readonly(),
            turn: activeTurnSnapshotSchema.nullable(),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("find"),
            entry: nativeSessionEntrySchema,
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("list"),
            capabilities: sessionCapabilitiesSchema,
            entries: z.array(nativeSessionEntrySchema).max(500).readonly(),
            nextCursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.enum(["import", "fork"]),
            targetSessionId: identifier,
            ready: sessionReadyEventSchema,
            title: z.string().max(500),
        })
        .readonly(),
]);
export type NativeSessionResult = z.infer<typeof nativeSessionResultSchema>;

const nativeSessionCancelSchema = z.object({ ...envelope, kind: z.literal(NATIVE_SESSION_CANCEL_KIND) }).readonly();
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
