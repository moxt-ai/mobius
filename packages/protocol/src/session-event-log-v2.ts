import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";

const MAX_EVENT_COUNT = 10_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_CONTENT_LENGTH = 1_000_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 1_000;
export const SESSION_EVENT_V2_KIND = "session.event.v2";

const boundedString = z.string().max(MAX_CONTENT_LENGTH);
const shortString = z.string().max(2_048);

function boundedJsonIssue(value: unknown, depth = 0): string | null {
    if (depth > MAX_JSON_DEPTH) {
        return "JSON nesting exceeds the maximum depth";
    }
    if (typeof value === "string") {
        return value.length <= MAX_CONTENT_LENGTH ? null : "JSON string exceeds the maximum length";
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
const optionalMetadata = metadataSchema.nullable().optional();
const annotationsSchema = z
    .strictObject({
        _meta: optionalMetadata,
        audience: z
            .array(z.enum(["assistant", "user"]))
            .max(2)
            .readonly()
            .nullable()
            .optional(),
        lastModified: shortString.nullable().optional(),
        priority: z.number().finite().nullable().optional(),
    })
    .readonly();
const contentFields = { _meta: optionalMetadata, annotations: annotationsSchema.nullable().optional() };
const textContentSchema = z.strictObject({ ...contentFields, text: boundedString, type: z.literal("text") }).readonly();
const imageContentSchema = z
    .strictObject({
        ...contentFields,
        data: boundedString,
        mimeType: shortString,
        type: z.literal("image"),
        uri: boundedString.nullable().optional(),
    })
    .readonly();
const audioContentSchema = z
    .strictObject({ ...contentFields, data: boundedString, mimeType: shortString, type: z.literal("audio") })
    .readonly();
const resourceLinkSchema = z
    .strictObject({
        ...contentFields,
        description: boundedString.nullable().optional(),
        mimeType: shortString.nullable().optional(),
        name: shortString,
        size: z.number().int().nonnegative().safe().nullable().optional(),
        title: shortString.nullable().optional(),
        type: z.literal("resource_link"),
        uri: boundedString,
    })
    .readonly();
const textResourceSchema = z
    .strictObject({
        _meta: optionalMetadata,
        mimeType: shortString.nullable().optional(),
        text: boundedString,
        uri: boundedString,
    })
    .readonly();
const blobResourceSchema = z
    .strictObject({
        _meta: optionalMetadata,
        blob: boundedString,
        mimeType: shortString.nullable().optional(),
        uri: boundedString,
    })
    .readonly();
const embeddedResourceSchema = z
    .strictObject({
        ...contentFields,
        resource: z.union([textResourceSchema, blobResourceSchema]),
        type: z.literal("resource"),
    })
    .readonly();

export const contentBlockV2Schema = z.discriminatedUnion("type", [
    textContentSchema,
    imageContentSchema,
    audioContentSchema,
    resourceLinkSchema,
    embeddedResourceSchema,
]);
export type ContentBlockV2 = z.infer<typeof contentBlockV2Schema>;

const toolCallContentSchema = z.discriminatedUnion("type", [
    z.strictObject({ _meta: optionalMetadata, content: contentBlockV2Schema, type: z.literal("content") }).readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            newText: boundedString,
            oldText: boundedString.nullable().optional(),
            path: boundedString,
            type: z.literal("diff"),
        })
        .readonly(),
    z.strictObject({ _meta: optionalMetadata, terminalId: shortString, type: z.literal("terminal") }).readonly(),
]);
const toolCallLocationSchema = z
    .strictObject({
        _meta: optionalMetadata,
        line: z.number().int().nonnegative().safe().nullable().optional(),
        path: boundedString,
    })
    .readonly();
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
const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const toolPatchFields = {
    _meta: optionalMetadata,
    content: z.array(toolCallContentSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
    kind: toolKindSchema.nullable().optional(),
    locations: z.array(toolCallLocationSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
    name: shortString.nullable().optional(),
    rawInput: boundedJsonSchema.optional(),
    rawOutput: boundedJsonSchema.optional(),
    status: toolStatusSchema.nullable().optional(),
    title: boundedString.nullable().optional(),
};
const planEntrySchema = z
    .strictObject({
        _meta: optionalMetadata,
        content: boundedString,
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
    })
    .readonly();
const planContentSchema = z.discriminatedUnion("type", [
    z
        .strictObject({
            _meta: optionalMetadata,
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            planId: shortString,
            type: z.literal("items"),
        })
        .readonly(),
    z
        .strictObject({ _meta: optionalMetadata, planId: shortString, type: z.literal("file"), uri: boundedString })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            content: boundedString,
            planId: shortString,
            type: z.literal("markdown"),
        })
        .readonly(),
]);
const commandSchema = z
    .strictObject({
        _meta: optionalMetadata,
        description: boundedString,
        input: z.strictObject({ _meta: optionalMetadata, hint: boundedString }).readonly().nullable().optional(),
        name: shortString,
    })
    .readonly();
const configSelectOptionSchema = z
    .strictObject({
        _meta: optionalMetadata,
        description: boundedString.nullable().optional(),
        name: shortString,
        value: shortString,
    })
    .readonly();
const configSelectGroupSchema = z
    .strictObject({
        _meta: optionalMetadata,
        group: shortString,
        name: shortString,
        options: z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
    })
    .readonly();
const configBaseFields = {
    _meta: optionalMetadata,
    category: shortString.nullable().optional(),
    description: boundedString.nullable().optional(),
    id: shortString,
    name: shortString,
};
const sessionConfigOptionSchema = z.discriminatedUnion("type", [
    z
        .strictObject({
            ...configBaseFields,
            currentValue: shortString,
            options: z.union([
                z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
                z.array(configSelectGroupSchema).max(MAX_COLLECTION_SIZE).readonly(),
            ]),
            type: z.literal("select"),
        })
        .readonly(),
    z.strictObject({ ...configBaseFields, currentValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);
const contentChunkFields = {
    _meta: optionalMetadata,
    content: contentBlockV2Schema,
    messageId: shortString.nullable().optional(),
};

export const acpSessionUpdateV2Schema = z.discriminatedUnion("sessionUpdate", [
    z.strictObject({ ...contentChunkFields, sessionUpdate: z.literal("user_message_chunk") }).readonly(),
    z.strictObject({ ...contentChunkFields, sessionUpdate: z.literal("agent_message_chunk") }).readonly(),
    z.strictObject({ ...contentChunkFields, sessionUpdate: z.literal("agent_thought_chunk") }).readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            content: z.array(toolCallContentSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
            kind: toolKindSchema.optional(),
            locations: z.array(toolCallLocationSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
            name: shortString.nullable().optional(),
            rawInput: boundedJsonSchema.optional(),
            rawOutput: boundedJsonSchema.optional(),
            sessionUpdate: z.literal("tool_call"),
            status: toolStatusSchema.optional(),
            title: boundedString,
            toolCallId: shortString,
        })
        .readonly(),
    z
        .strictObject({ ...toolPatchFields, sessionUpdate: z.literal("tool_call_update"), toolCallId: shortString })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("plan"),
        })
        .readonly(),
    z
        .strictObject({ _meta: optionalMetadata, plan: planContentSchema, sessionUpdate: z.literal("plan_update") })
        .readonly(),
    z
        .strictObject({ _meta: optionalMetadata, planId: shortString, sessionUpdate: z.literal("plan_removed") })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            availableCommands: z.array(commandSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("available_commands_update"),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            currentModeId: shortString,
            sessionUpdate: z.literal("current_mode_update"),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            configOptions: z.array(sessionConfigOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("config_option_update"),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            sessionUpdate: z.literal("session_info_update"),
            title: boundedString.nullable().optional(),
            updatedAt: shortString.nullable().optional(),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            cost: z
                .strictObject({ _meta: optionalMetadata, amount: z.number().finite(), currency: z.string().max(16) })
                .readonly()
                .nullable()
                .optional(),
            sessionUpdate: z.literal("usage_update"),
            size: z.number().int().nonnegative().safe(),
            used: z.number().int().nonnegative().safe(),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            compactionId: shortString,
            error: boundedString.nullable().optional(),
            sessionUpdate: z.literal("compaction_update"),
            status: shortString,
            summary: z.array(contentBlockV2Schema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
        })
        .readonly(),
    z
        .strictObject({
            _meta: optionalMetadata,
            compactionId: shortString,
            content: contentBlockV2Schema,
            sessionUpdate: z.literal("compaction_summary_chunk"),
        })
        .readonly(),
]);
export type AcpSessionUpdateV2 = z.infer<typeof acpSessionUpdateV2Schema>;

const lifecycleBase = { commandId: identifier };
export const sessionEventPayloadV2Schema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("acp.session.update"), update: acpSessionUpdateV2Schema }).readonly(),
    z
        .strictObject({
            ...lifecycleBase,
            content: z.array(contentBlockV2Schema).min(1).max(100).readonly(),
            kind: z.literal("prompt.requested"),
        })
        .readonly(),
    z
        .strictObject({ ...lifecycleBase, attemptId: identifier, epoch: identifier, kind: z.literal("prompt.started") })
        .readonly(),
    z.strictObject({ ...lifecycleBase, kind: z.literal("prompt.completed"), stopReason: shortString }).readonly(),
    z
        .strictObject({
            ...lifecycleBase,
            code: identifier,
            kind: z.literal("prompt.failed-before-start"),
            message: z.string().min(1).max(500),
        })
        .readonly(),
    z
        .strictObject({
            ...lifecycleBase,
            attemptId: identifier,
            code: identifier,
            kind: z.literal("prompt.failed"),
            message: z.string().min(1).max(500),
        })
        .readonly(),
]);
export type SessionEventPayloadV2 = z.infer<typeof sessionEventPayloadV2Schema>;
const positionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const provenanceSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("original") }).readonly(),
    z
        .strictObject({
            kind: z.literal("imported"),
            sourceEventId: identifier,
            sourcePosition: positionSchema,
            sourceSessionId: identifier,
        })
        .readonly(),
    z
        .strictObject({
            kind: z.literal("forked"),
            sourceEventId: identifier,
            sourcePosition: positionSchema,
            sourceSessionId: identifier,
        })
        .readonly(),
]);
export const sessionEventV2Schema = z
    .strictObject({
        eventId: identifier,
        payload: sessionEventPayloadV2Schema,
        position: positionSchema,
        provenance: provenanceSchema,
        recordedAt: z.iso.datetime({ offset: true }),
        sessionId: identifier,
    })
    .readonly();
export type SessionEventV2 = z.infer<typeof sessionEventV2Schema>;
export const sessionEventEnvelopeV2Schema = z
    .strictObject({ event: sessionEventV2Schema, kind: z.literal(SESSION_EVENT_V2_KIND) })
    .readonly();
export type SessionEventEnvelopeV2 = z.infer<typeof sessionEventEnvelopeV2Schema>;
export const sessionEventLogPageV2Schema = z
    .strictObject({
        events: z.array(sessionEventV2Schema).max(MAX_EVENT_COUNT).readonly(),
        nextCursor: z.string().min(1).max(512).nullable(),
        tailCursor: z.string().max(512),
        truncated: z.boolean(),
        version: z.literal(2),
    })
    .readonly();
export type SessionEventLogPageV2 = z.infer<typeof sessionEventLogPageV2Schema>;
export const nativeEventPageRequestV2Schema = z
    .strictObject({ cursor: z.string().min(1).max(512).nullable(), eventLimit: z.number().int().min(1).max(10_000) })
    .readonly();
export type NativeEventPageRequestV2 = z.infer<typeof nativeEventPageRequestV2Schema>;
const executingPromptRequestEventLogV2Schema = z
    .strictObject({
        attemptId: identifier,
        commandId: identifier,
        epoch: identifier,
        events: z.array(sessionEventV2Schema).max(MAX_EVENT_COUNT).readonly(),
        tailCursor: z.string().max(512),
        truncated: z.boolean(),
    })
    .readonly();
export type ExecutingPromptRequestEventLogV2 = z.infer<typeof executingPromptRequestEventLogV2Schema>;
export const nativeSessionEventsV2Schema = z
    .strictObject({
        executingPromptRequest: executingPromptRequestEventLogV2Schema.nullable(),
        history: sessionEventLogPageV2Schema,
    })
    .readonly();
export type NativeSessionEventsV2 = z.infer<typeof nativeSessionEventsV2Schema>;

function inputValue(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch (cause) {
        throw new ProtocolMessageError("Session Event Log V2 message is not valid JSON", { cause });
    }
}
function decode<T>(value: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(inputValue(value));
    if (!result.success) {
        throw new ProtocolMessageError("Session Event Log V2 message does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}
function encode<T>(value: T, schema: z.ZodType<T>): string {
    return JSON.stringify(decode(value, schema));
}
export const decodeSessionEventV2 = (value: unknown): SessionEventV2 => decode(value, sessionEventV2Schema);
export const encodeSessionEventV2 = (value: SessionEventV2): string => encode(value, sessionEventV2Schema);
export const decodeSessionEventEnvelopeV2 = (value: unknown): SessionEventEnvelopeV2 =>
    decode(value, sessionEventEnvelopeV2Schema);
export const encodeSessionEventEnvelopeV2 = (value: SessionEventEnvelopeV2): string =>
    encode(value, sessionEventEnvelopeV2Schema);
export const decodeAcpSessionUpdateV2 = (value: unknown): AcpSessionUpdateV2 => decode(value, acpSessionUpdateV2Schema);
export const decodeSessionEventLogPageV2 = (value: unknown): SessionEventLogPageV2 =>
    decode(value, sessionEventLogPageV2Schema);
export const encodeSessionEventLogPageV2 = (value: SessionEventLogPageV2): string =>
    encode(value, sessionEventLogPageV2Schema);
export const decodeNativeSessionEventsV2 = (value: unknown): NativeSessionEventsV2 =>
    decode(value, nativeSessionEventsV2Schema);
export const encodeNativeSessionEventsV2 = (value: NativeSessionEventsV2): string =>
    encode(value, nativeSessionEventsV2Schema);
