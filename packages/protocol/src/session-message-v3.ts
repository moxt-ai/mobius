import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";

const MAX_COLLECTION_SIZE = 1_000;
const MAX_MESSAGE_ID_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 1_000;
const cursorSchema = z.string().min(1).max(4_096).nullable();
const messageIdSchema = z.string().min(1).max(MAX_MESSAGE_ID_LENGTH);
const shortTextSchema = z.string().max(2_048);
const longTextSchema = z.string().max(MAX_TEXT_LENGTH);
const directoryIdentifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/);
const externalContentKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const SESSION_HISTORY_V3_PAGE_LOAD_KIND = "session.history.v3.page.load";
export const SESSION_HISTORY_V3_PAGE_LOADED_KIND = "session.history.v3.page.loaded";
export const SESSION_PREVIEW_HISTORY_V3_PAGE_LOAD_KIND = "session.preview-history.v3.page.load";
export const SESSION_PREVIEW_HISTORY_V3_PAGE_LOADED_KIND = "session.preview-history.v3.page.loaded";

function boundedJsonIssue(value: unknown, depth = 0): string | null {
    if (depth > MAX_JSON_DEPTH) {
        return "JSON nesting exceeds the maximum depth";
    }
    if (typeof value === "string") {
        return value.length <= MAX_TEXT_LENGTH ? null : "JSON string exceeds the maximum length";
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? null : "JSON number must be finite";
    }
    if (typeof value === "boolean" || value === null) {
        return null;
    }
    if (Array.isArray(value)) {
        if (value.length > MAX_COLLECTION_SIZE) {
            return "JSON array exceeds the maximum length";
        }
        for (const item of value) {
            const issue = boundedJsonIssue(item, depth + 1);
            if (issue !== null) {
                return issue;
            }
        }
        return null;
    }
    if (typeof value === "object" && value !== undefined) {
        const entries = Object.entries(value);
        if (entries.length > MAX_JSON_KEYS) {
            return "JSON object exceeds the maximum key count";
        }
        for (const [key, item] of entries) {
            if (key.length > 255) {
                return "JSON key exceeds the maximum length";
            }
            const issue = boundedJsonIssue(item, depth + 1);
            if (issue !== null) {
                return issue;
            }
        }
        return null;
    }
    return "Value is not bounded JSON";
}

const boundedJsonSchema = z.unknown().superRefine((value, context) => {
    const issue = boundedJsonIssue(value);
    if (issue !== null) {
        context.addIssue({ code: "custom", message: issue });
    }
});
const metadataSchema = z.record(z.string().max(255), boundedJsonSchema).readonly();
const optionalMetadataSchema = metadataSchema.nullable().optional();
const annotationsSchema = z
    .strictObject({
        _meta: optionalMetadataSchema,
        audience: z
            .array(z.enum(["assistant", "user"]))
            .max(2)
            .readonly()
            .nullable()
            .optional(),
        lastModified: shortTextSchema.nullable().optional(),
        priority: z.number().finite().nullable().optional(),
    })
    .readonly();
const contentFields = {
    _meta: optionalMetadataSchema,
    annotations: annotationsSchema.nullable().optional(),
};
const textContentV3Schema = z
    .strictObject({ ...contentFields, text: longTextSchema, type: z.literal("text") })
    .readonly();
const externalImageContentV3Schema = z
    .strictObject({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        imageKey: externalContentKeySchema,
        mimeType: shortTextSchema,
        type: z.literal("external_image"),
        uri: longTextSchema.nullable().optional(),
    })
    .readonly();
const externalAudioContentV3Schema = z
    .strictObject({
        ...contentFields,
        audioKey: externalContentKeySchema,
        byteLength: z.number().int().positive().safe(),
        mimeType: shortTextSchema,
        type: z.literal("external_audio"),
    })
    .readonly();
const externalResourceContentV3Schema = z
    .strictObject({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        encoding: z.enum(["binary", "text"]),
        mimeType: shortTextSchema.nullable().optional(),
        resourceKey: externalContentKeySchema,
        type: z.literal("external_resource"),
        uri: longTextSchema,
    })
    .readonly();

export const contentBlockV3Schema = z.discriminatedUnion("type", [
    textContentV3Schema,
    externalImageContentV3Schema,
    externalAudioContentV3Schema,
    externalResourceContentV3Schema,
]);
export type ContentBlockV3 = z.infer<typeof contentBlockV3Schema>;

const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const toolKindSchema = z.enum([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
]);
const toolLocationSchema = z
    .strictObject({ line: z.number().int().nonnegative().safe().optional(), path: longTextSchema })
    .readonly();
const toolContentSchema = z.discriminatedUnion("type", [
    z.strictObject({ content: contentBlockV3Schema, type: z.literal("content") }).readonly(),
    z
        .strictObject({
            newText: longTextSchema,
            oldText: longTextSchema.optional(),
            path: longTextSchema,
            type: z.literal("diff"),
        })
        .readonly(),
    z.strictObject({ terminalId: shortTextSchema, type: z.literal("terminal") }).readonly(),
]);
const planEntrySchema = z
    .strictObject({
        content: longTextSchema,
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
    })
    .readonly();
const historyToolCallFields = {
    content: z.array(toolContentSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
    kind: toolKindSchema.optional(),
    locations: z.array(toolLocationSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
    name: shortTextSchema.optional(),
    status: toolStatusSchema.optional(),
    title: longTextSchema,
    toolCallId: z.string().min(1).max(2_048),
};

export const sessionHistoryItemV3Schema = z.discriminatedUnion("sessionUpdate", [
    z
        .strictObject({
            content: z.array(contentBlockV3Schema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("user_message"),
        })
        .readonly(),
    z
        .strictObject({
            content: z.array(contentBlockV3Schema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("agent_message"),
        })
        .readonly(),
    z
        .strictObject({
            content: z.array(contentBlockV3Schema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("agent_thought"),
        })
        .readonly(),
    z.strictObject({ ...historyToolCallFields, sessionUpdate: z.literal("tool_call") }).readonly(),
    z
        .strictObject({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("plan"),
        })
        .readonly(),
]);
export type SessionHistoryItemV3 = z.infer<typeof sessionHistoryItemV3Schema>;

export const sessionHistoryMessageV3Schema = z
    .strictObject({ item: sessionHistoryItemV3Schema, messageId: messageIdSchema, sessionId: identifier })
    .readonly();
export type SessionHistoryMessageV3 = z.infer<typeof sessionHistoryMessageV3Schema>;

export const sessionHistoryPageRequestV3Schema = z
    .strictObject({ cursor: cursorSchema, messageLimit: z.number().int().min(1).max(1_000), sessionId: identifier })
    .readonly();
export type SessionHistoryPageRequestV3 = z.infer<typeof sessionHistoryPageRequestV3Schema>;

export const sessionHistoryPageV3Schema = z
    .strictObject({
        messages: z.array(sessionHistoryMessageV3Schema).max(1_000).readonly(),
        nextCursor: cursorSchema,
        throughSeq: z.number().int().nonnegative().safe(),
    })
    .readonly()
    .superRefine((page, context) => {
        const identities = new Set<string>();
        for (const [index, message] of page.messages.entries()) {
            if (identities.has(message.messageId)) {
                context.addIssue({
                    code: "custom",
                    message: "A V3 history page cannot repeat a message identity",
                    path: ["messages", index, "messageId"],
                });
            }
            identities.add(message.messageId);
        }
    });
export type SessionHistoryPageV3 = z.infer<typeof sessionHistoryPageV3Schema>;

const sessionHistoryPageLoadV3Schema = z
    .strictObject({
        cursor: cursorSchema,
        kind: z.literal(SESSION_HISTORY_V3_PAGE_LOAD_KIND),
        messageLimit: z.number().int().min(1).max(1_000),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();
const sessionHistoryPageLoadedV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_HISTORY_V3_PAGE_LOADED_KIND),
        page: sessionHistoryPageV3Schema,
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly()
    .superRefine((message, context) => validatePageSession(message.sessionId, message.page, context));
const sessionPreviewHistoryPageLoadV3Schema = z
    .strictObject({
        additionalDirectoryIds: z.array(directoryIdentifierSchema).max(16).readonly(),
        agentId: identifier,
        bindingId: identifier,
        cursor: cursorSchema,
        directoryId: directoryIdentifierSchema,
        kind: z.literal(SESSION_PREVIEW_HISTORY_V3_PAGE_LOAD_KIND),
        messageLimit: z.number().int().min(1).max(1_000),
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly();
const sessionPreviewHistoryPageLoadedV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_PREVIEW_HISTORY_V3_PAGE_LOADED_KIND),
        page: sessionHistoryPageV3Schema,
        requestId: identifier,
        sessionId: identifier,
    })
    .readonly()
    .superRefine((message, context) => validatePageSession(message.sessionId, message.page, context));

export type SessionHistoryPageLoadV3 = z.infer<typeof sessionHistoryPageLoadV3Schema>;
export type SessionHistoryPageLoadedV3 = z.infer<typeof sessionHistoryPageLoadedV3Schema>;
export type SessionPreviewHistoryPageLoadV3 = z.infer<typeof sessionPreviewHistoryPageLoadV3Schema>;
export type SessionPreviewHistoryPageLoadedV3 = z.infer<typeof sessionPreviewHistoryPageLoadedV3Schema>;

function validatePageSession(sessionId: string, page: SessionHistoryPageV3, context: z.RefinementCtx): void {
    for (const [index, message] of page.messages.entries()) {
        if (message.sessionId !== sessionId) {
            context.addIssue({
                code: "custom",
                message: "A V3 history message belongs to a different Session",
                path: ["page", "messages", index, "sessionId"],
            });
        }
    }
}

function inputValue(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch (cause) {
        throw new ProtocolMessageError("Session V3 message is not valid JSON", { cause });
    }
}

function decode<T>(value: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(inputValue(value));
    if (!result.success) {
        throw new ProtocolMessageError("Session V3 message does not match its schema", { cause: result.error });
    }
    return result.data;
}

function encode<T>(value: T, schema: z.ZodType<T>): string {
    return JSON.stringify(decode(value, schema));
}

export const decodeSessionHistoryPageLoadV3 = (value: unknown): SessionHistoryPageLoadV3 =>
    decode(value, sessionHistoryPageLoadV3Schema);
export const encodeSessionHistoryPageLoadV3 = (value: SessionHistoryPageLoadV3): string =>
    encode(value, sessionHistoryPageLoadV3Schema);
export const decodeSessionHistoryPageV3 = (value: unknown): SessionHistoryPageV3 =>
    decode(value, sessionHistoryPageV3Schema);
export const decodeSessionHistoryPageLoadedV3 = (value: unknown): SessionHistoryPageLoadedV3 =>
    decode(value, sessionHistoryPageLoadedV3Schema);
export const encodeSessionHistoryPageLoadedV3 = (value: SessionHistoryPageLoadedV3): string =>
    encode(value, sessionHistoryPageLoadedV3Schema);
export const decodeSessionPreviewHistoryPageLoadV3 = (value: unknown): SessionPreviewHistoryPageLoadV3 =>
    decode(value, sessionPreviewHistoryPageLoadV3Schema);
export const encodeSessionPreviewHistoryPageLoadV3 = (value: SessionPreviewHistoryPageLoadV3): string =>
    encode(value, sessionPreviewHistoryPageLoadV3Schema);
export const decodeSessionPreviewHistoryPageLoadedV3 = (value: unknown): SessionPreviewHistoryPageLoadedV3 =>
    decode(value, sessionPreviewHistoryPageLoadedV3Schema);
export const encodeSessionPreviewHistoryPageLoadedV3 = (value: SessionPreviewHistoryPageLoadedV3): string =>
    encode(value, sessionPreviewHistoryPageLoadedV3Schema);
