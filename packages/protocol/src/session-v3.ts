import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { identifierStringSchema as identifier } from "./identifier.ts";
import { contentBlockV3Schema } from "./session-message-v3.ts";

const MAX_BATCH_SIZE = 1_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_MESSAGE_ID_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 1_000_000;
const messageIdSchema = z.string().min(1).max(MAX_MESSAGE_ID_LENGTH);
const requestIdSchema = z.string().min(1).max(2_048);
const shortTextSchema = z.string().max(2_048);
const longTextSchema = z.string().max(MAX_TEXT_LENGTH);
const safeSequenceSchema = z.number().int().positive().safe();

export const SESSION_LIVE_V3_KIND = "session.live.v3";
export const SESSION_PERMISSION_V3_RESPOND_KIND = "session.permission.v3.respond";
export const SESSION_USER_INPUT_V3_RESPOND_KIND = "session.user-input.v3.respond";
export const SESSION_SETTINGS_V3_READ_KIND = "session.settings.v3.read";
export const SESSION_SETTINGS_V3_LOADED_KIND = "session.settings.v3.loaded";
export const SESSION_SETTING_V3_CHANGE_KIND = "session.setting.v3.change";
export const SESSION_LIVE_V3_BATCH_MAX_SIZE = MAX_BATCH_SIZE;

const messageChunkFields = {
    content: contentBlockV3Schema,
    messageId: messageIdSchema,
};
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
const configOptionSchema = z
    .strictObject({
        currentValue: z.union([z.string().max(2_048), z.boolean()]),
        description: longTextSchema.optional(),
        id: shortTextSchema,
        name: shortTextSchema,
        options: z
            .array(
                z
                    .strictObject({
                        description: longTextSchema.optional(),
                        name: shortTextSchema,
                        value: shortTextSchema,
                    })
                    .readonly(),
            )
            .max(MAX_COLLECTION_SIZE)
            .readonly()
            .optional(),
    })
    .readonly();
const availableCommandSchema = z
    .strictObject({ description: longTextSchema, inputHint: longTextSchema.optional(), name: shortTextSchema })
    .readonly();
export const sessionPermissionOptionV3Schema = z
    .strictObject({
        kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
        name: z.string().min(1).max(255),
        optionId: z.string().min(1).max(255),
    })
    .readonly();
export type SessionPermissionOptionV3 = z.infer<typeof sessionPermissionOptionV3Schema>;
const userInputOptionSchema = z
    .strictObject({ description: longTextSchema.optional(), label: shortTextSchema, value: longTextSchema })
    .readonly();
export const sessionUserInputFieldV3Schema = z
    .strictObject({
        description: longTextSchema.optional(),
        name: z.string().min(1).max(128),
        options: z.array(userInputOptionSchema).max(200).readonly().optional(),
        required: z.boolean(),
        title: shortTextSchema,
        type: z.enum(["boolean", "integer", "multiselect", "number", "select", "string", "text"]),
    })
    .readonly();
export type SessionUserInputFieldV3 = z.infer<typeof sessionUserInputFieldV3Schema>;
const settingSchema = z
    .strictObject({
        id: z.string().min(1).max(255),
        name: shortTextSchema,
        value: z.union([z.string().max(2_048), z.boolean(), z.number().finite()]),
    })
    .readonly();
export const sessionSettingsV3Schema = z
    .strictObject({ settings: z.array(settingSchema).max(MAX_COLLECTION_SIZE).readonly() })
    .readonly();
export type SessionSettingsV3 = z.infer<typeof sessionSettingsV3Schema>;
const executionContextSchema = z
    .strictObject({
        additionalDirectoryIds: z.array(z.string().min(1).max(2_048)).max(16).readonly(),
        agentId: identifier,
        directoryId: z.string().min(1).max(2_048),
    })
    .readonly();
const lifecycleStateSchema = z.discriminatedUnion("kind", [
    z.strictObject({ context: executionContextSchema, kind: z.literal("connected") }).readonly(),
    z.strictObject({ context: executionContextSchema, kind: z.literal("running") }).readonly(),
    z.strictObject({ kind: z.literal("idle") }).readonly(),
    z.strictObject({ code: identifier, kind: z.literal("failed") }).readonly(),
    z
        .strictObject({
            kind: z.literal("disconnected"),
            outcome: z.discriminatedUnion("kind", [
                z.strictObject({ kind: z.literal("closed") }).readonly(),
                z.strictObject({ code: identifier, kind: z.literal("failed") }).readonly(),
            ]),
        })
        .readonly(),
]);

const liveMessageSchemas = [
    z.strictObject({ ...messageChunkFields, sessionUpdate: z.literal("user_message_chunk") }).readonly(),
    z.strictObject({ ...messageChunkFields, sessionUpdate: z.literal("agent_message_chunk") }).readonly(),
    z.strictObject({ ...messageChunkFields, sessionUpdate: z.literal("agent_thought_chunk") }).readonly(),
] as const;
const toolCallFields = {
    content: z.array(toolContentSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
    kind: toolKindSchema.optional(),
    locations: z.array(toolLocationSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
    messageId: messageIdSchema,
    name: shortTextSchema.optional(),
    status: toolStatusSchema.optional(),
    title: longTextSchema,
    toolCallId: z.string().min(1).max(2_048),
};

export const sessionLiveEventItemV3Schema = z.discriminatedUnion("sessionUpdate", [
    ...liveMessageSchemas,
    z.strictObject({ ...toolCallFields, sessionUpdate: z.literal("tool_call") }).readonly(),
    z
        .strictObject({
            ...toolCallFields,
            sessionUpdate: z.literal("tool_call_update"),
            title: longTextSchema.optional(),
        })
        .readonly(),
    z
        .strictObject({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            messageId: messageIdSchema,
            sessionUpdate: z.literal("plan"),
        })
        .readonly(),
    z
        .strictObject({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            messageId: messageIdSchema,
            planId: z.string().min(1).max(2_048),
            sessionUpdate: z.literal("plan_update"),
        })
        .readonly(),
    z
        .strictObject({
            messageId: messageIdSchema,
            planId: z.string().min(1).max(2_048),
            sessionUpdate: z.literal("plan_removed"),
        })
        .readonly(),
    z
        .strictObject({
            sessionUpdate: z.literal("session_info_update"),
            title: longTextSchema.optional(),
            updatedAt: z.iso.datetime({ offset: true }).optional(),
        })
        .readonly(),
    z
        .strictObject({
            configOptions: z.array(configOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("config_option_update"),
        })
        .readonly(),
    z
        .strictObject({
            availableCommands: z.array(availableCommandSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("available_commands_update"),
        })
        .readonly(),
    z
        .strictObject({
            cost: z
                .strictObject({ amount: z.number().finite(), currency: z.string().min(1).max(16) })
                .readonly()
                .optional(),
            sessionUpdate: z.literal("usage_update"),
            size: z.number().int().nonnegative().safe(),
            used: z.number().int().nonnegative().safe(),
        })
        .readonly(),
    z
        .strictObject({
            options: z.array(sessionPermissionOptionV3Schema).min(1).max(20).readonly(),
            requestId: requestIdSchema,
            sessionUpdate: z.literal("permission_requested"),
            title: longTextSchema,
            toolCallId: z.string().min(1).max(2_048),
        })
        .readonly(),
    z
        .strictObject({
            outcome: z.enum(["selected", "cancelled", "timed_out", "failed"]),
            requestId: requestIdSchema,
            selectedOptionId: z.string().min(1).max(255).optional(),
            sessionUpdate: z.literal("permission_resolved"),
        })
        .readonly(),
    z
        .strictObject({
            fields: z.array(sessionUserInputFieldV3Schema).max(100).readonly(),
            message: longTextSchema,
            requestId: requestIdSchema,
            sessionUpdate: z.literal("user_input_requested"),
            toolCallId: z.string().min(1).max(2_048).optional(),
        })
        .readonly(),
    z
        .strictObject({
            outcome: z.enum(["submitted", "cancelled", "timed_out", "failed"]),
            requestId: requestIdSchema,
            sessionUpdate: z.literal("user_input_resolved"),
        })
        .readonly(),
    z
        .strictObject({ sessionUpdate: z.literal("session_settings_changed"), settings: sessionSettingsV3Schema })
        .readonly(),
    z
        .strictObject({
            sessionUpdate: z.literal("session_lifecycle_changed"),
            state: lifecycleStateSchema,
        })
        .readonly(),
]);
export type SessionLiveEventItemV3 = z.infer<typeof sessionLiveEventItemV3Schema>;

export const sessionLiveEventV3Schema = z
    .strictObject({ item: sessionLiveEventItemV3Schema, seq: safeSequenceSchema, sessionId: identifier })
    .readonly();
export type SessionLiveEventV3 = z.infer<typeof sessionLiveEventV3Schema>;

export const sessionLiveEventEnvelopeV3Schema = z
    .strictObject({
        events: z.array(sessionLiveEventV3Schema).min(1).max(MAX_BATCH_SIZE).readonly(),
        kind: z.literal(SESSION_LIVE_V3_KIND),
    })
    .readonly()
    .superRefine((envelope, context) => {
        const previousBySession = new Map<string, number>();
        for (const [index, event] of envelope.events.entries()) {
            const previous = previousBySession.get(event.sessionId);
            if (previous !== undefined && event.seq <= previous) {
                context.addIssue({
                    code: "custom",
                    message: "V3 live event sequences must increase within each Session",
                    path: ["events", index, "seq"],
                });
            }
            previousBySession.set(event.sessionId, event.seq);
        }
    });
export type SessionLiveEventEnvelopeV3 = z.infer<typeof sessionLiveEventEnvelopeV3Schema>;

const sessionPermissionResponseV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_PERMISSION_V3_RESPOND_KIND),
        optionId: z.string().min(1).max(255),
        requestId: requestIdSchema,
        sessionId: identifier,
    })
    .readonly();
const userInputValueSchema = z.union([
    z.string().max(MAX_TEXT_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_COLLECTION_SIZE).readonly(),
]);
const sessionUserInputResponseV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_USER_INPUT_V3_RESPOND_KIND),
        requestId: requestIdSchema,
        sessionId: identifier,
        values: z.record(z.string().min(1).max(128), userInputValueSchema).readonly(),
    })
    .readonly();
const sessionSettingsReadV3Schema = z
    .strictObject({ kind: z.literal(SESSION_SETTINGS_V3_READ_KIND), requestId: identifier, sessionId: identifier })
    .readonly();
const sessionSettingsLoadedV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_SETTINGS_V3_LOADED_KIND),
        requestId: identifier,
        sessionId: identifier,
        settings: sessionSettingsV3Schema,
    })
    .readonly();
const sessionSettingChangeV3Schema = z
    .strictObject({
        kind: z.literal(SESSION_SETTING_V3_CHANGE_KIND),
        requestId: identifier,
        sessionId: identifier,
        settingId: z.string().min(1).max(255),
        value: z.union([z.string().max(2_048), z.boolean(), z.number().finite()]),
    })
    .readonly();
export type SessionPermissionResponseV3 = z.infer<typeof sessionPermissionResponseV3Schema>;
export type SessionUserInputResponseV3 = z.infer<typeof sessionUserInputResponseV3Schema>;
export type SessionSettingsReadV3 = z.infer<typeof sessionSettingsReadV3Schema>;
export type SessionSettingsLoadedV3 = z.infer<typeof sessionSettingsLoadedV3Schema>;
export type SessionSettingChangeV3 = z.infer<typeof sessionSettingChangeV3Schema>;

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

export const decodeSessionLiveEventV3 = (value: unknown): SessionLiveEventV3 => decode(value, sessionLiveEventV3Schema);
export const decodeSessionSettingsV3 = (value: unknown): SessionSettingsV3 => decode(value, sessionSettingsV3Schema);
export const encodeSessionLiveEventV3 = (value: SessionLiveEventV3): string => encode(value, sessionLiveEventV3Schema);
export const decodeSessionLiveEventEnvelopeV3 = (value: unknown): SessionLiveEventEnvelopeV3 =>
    decode(value, sessionLiveEventEnvelopeV3Schema);
export const encodeSessionLiveEventEnvelopeV3 = (value: SessionLiveEventEnvelopeV3): string =>
    encode(value, sessionLiveEventEnvelopeV3Schema);
export const decodeSessionPermissionResponseV3 = (value: unknown): SessionPermissionResponseV3 =>
    decode(value, sessionPermissionResponseV3Schema);
export const encodeSessionPermissionResponseV3 = (value: SessionPermissionResponseV3): string =>
    encode(value, sessionPermissionResponseV3Schema);
export const decodeSessionUserInputResponseV3 = (value: unknown): SessionUserInputResponseV3 =>
    decode(value, sessionUserInputResponseV3Schema);
export const encodeSessionUserInputResponseV3 = (value: SessionUserInputResponseV3): string =>
    encode(value, sessionUserInputResponseV3Schema);
export const decodeSessionSettingsReadV3 = (value: unknown): SessionSettingsReadV3 =>
    decode(value, sessionSettingsReadV3Schema);
export const encodeSessionSettingsReadV3 = (value: SessionSettingsReadV3): string =>
    encode(value, sessionSettingsReadV3Schema);
export const decodeSessionSettingsLoadedV3 = (value: unknown): SessionSettingsLoadedV3 =>
    decode(value, sessionSettingsLoadedV3Schema);
export const encodeSessionSettingsLoadedV3 = (value: SessionSettingsLoadedV3): string =>
    encode(value, sessionSettingsLoadedV3Schema);
export const decodeSessionSettingChangeV3 = (value: unknown): SessionSettingChangeV3 =>
    decode(value, sessionSettingChangeV3Schema);
export const encodeSessionSettingChangeV3 = (value: SessionSettingChangeV3): string =>
    encode(value, sessionSettingChangeV3Schema);
