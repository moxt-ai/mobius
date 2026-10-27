import { z } from "zod";
import { DIRECTORY_IDENTIFIER } from "../../shared/directory.ts";
import { boundedJsonSchema, toolCallLocationSchema } from "../../shared/tool-input.ts";

export { boundedJsonSchema, toolCallLocationSchema } from "../../shared/tool-input.ts";

import { identifierStringSchema as identifier } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import {
    sessionElicitationRequestedEventSchema,
    sessionElicitationResolvedEventSchema,
    sessionPermissionRequestedEventSchema,
    sessionPermissionResolvedEventSchema,
} from "../interactions/index.ts";

const MAX_EVENT_COUNT = 10_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_CONTENT_LENGTH = 1_000_000;
export const SESSION_EVENT_KIND = "session.event.v2";
export const SESSION_EVENT_BATCH_MAX_SIZE = 1_000;

const boundedString = z.string().max(MAX_CONTENT_LENGTH);
const shortString = z.string().max(2_048);
const externalContentKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

const annotationsSchema = z
    .object({
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
const contentFields = { annotations: annotationsSchema.nullable().optional() };
const textContentSchema = z.object({ ...contentFields, text: boundedString, type: z.literal("text") }).readonly();
const imageContentSchema = z
    .object({
        ...contentFields,
        data: z.string(),
        mimeType: shortString,
        type: z.literal("image"),
        uri: boundedString.nullable().optional(),
    })
    .readonly();
const audioContentSchema = z
    .object({ ...contentFields, data: z.string(), mimeType: shortString, type: z.literal("audio") })
    .readonly();
const externalImageContentSchema = z
    .object({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        imageKey: externalContentKeySchema,
        mimeType: shortString,
        type: z.literal("external_image"),
        uri: boundedString.nullable().optional(),
    })
    .readonly();
const externalAudioContentSchema = z
    .object({
        ...contentFields,
        audioKey: externalContentKeySchema,
        byteLength: z.number().int().positive().safe(),
        mimeType: shortString,
        type: z.literal("external_audio"),
    })
    .readonly();
const externalResourceContentSchema = z
    .object({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        encoding: z.enum(["binary", "text"]),
        mimeType: shortString.nullable().optional(),
        resourceKey: externalContentKeySchema,
        type: z.literal("external_resource"),
        uri: boundedString,
    })
    .readonly();
const resourceLinkSchema = z
    .object({
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
    .object({
        mimeType: shortString.nullable().optional(),
        text: boundedString,
        uri: boundedString,
    })
    .readonly();
const blobResourceSchema = z
    .object({
        blob: z.string(),
        mimeType: shortString.nullable().optional(),
        uri: boundedString,
    })
    .readonly();
const embeddedResourceSchema = z
    .object({
        ...contentFields,
        resource: z.union([textResourceSchema, blobResourceSchema]),
        type: z.literal("resource"),
    })
    .readonly();

export const contentBlockSchema = z.discriminatedUnion("type", [
    textContentSchema,
    imageContentSchema,
    audioContentSchema,
    resourceLinkSchema,
    embeddedResourceSchema,
    externalImageContentSchema,
    externalAudioContentSchema,
    externalResourceContentSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ExternalImageContentBlock = z.infer<typeof externalImageContentSchema>;
export type ExternalAudioContentBlock = z.infer<typeof externalAudioContentSchema>;
export type ExternalResourceContentBlock = z.infer<typeof externalResourceContentSchema>;

export const toolCallContentSchema = z.discriminatedUnion("type", [
    z.object({ content: contentBlockSchema, type: z.literal("content") }).readonly(),
    z
        .object({
            newText: boundedString,
            oldText: boundedString.nullable().optional(),
            path: boundedString,
            type: z.literal("diff"),
        })
        .readonly(),
    z.object({ terminalId: shortString, type: z.literal("terminal") }).readonly(),
]);
export const toolKindSchema = z.enum([
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
export const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const backgroundTaskSchema = z
    .object({
        id: shortString,
        status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
    })
    .readonly();
const toolPatchFields = {
    backgroundTask: backgroundTaskSchema.optional(),
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
    .object({
        content: boundedString,
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
    })
    .readonly();
const planContentSchema = z.discriminatedUnion("type", [
    z
        .object({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            planId: shortString,
            type: z.literal("items"),
        })
        .readonly(),
    z.object({ planId: shortString, type: z.literal("file"), uri: boundedString }).readonly(),
    z
        .object({
            content: boundedString,
            planId: shortString,
            type: z.literal("markdown"),
        })
        .readonly(),
]);
const commandSchema = z
    .object({
        description: boundedString,
        input: z.object({ hint: boundedString }).readonly().nullable().optional(),
        name: shortString,
    })
    .readonly();
const configSelectOptionSchema = z
    .object({
        description: boundedString.nullable().optional(),
        name: shortString,
        value: shortString,
    })
    .readonly();
const configSelectGroupSchema = z
    .object({
        group: shortString,
        name: shortString,
        options: z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
    })
    .readonly();
const configBaseFields = {
    category: shortString.nullable().optional(),
    description: boundedString.nullable().optional(),
    id: shortString,
    name: shortString,
};
const sessionConfigOptionSchema = z.discriminatedUnion("type", [
    z
        .object({
            ...configBaseFields,
            currentValue: shortString,
            options: z.union([
                z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
                z.array(configSelectGroupSchema).max(MAX_COLLECTION_SIZE).readonly(),
            ]),
            type: z.literal("select"),
        })
        .readonly(),
    z.object({ ...configBaseFields, currentValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);
const contentChunkFields = {
    content: contentBlockSchema,
    messageId: shortString.nullable().optional(),
};

export const acpSessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
    z.object({ ...contentChunkFields, sessionUpdate: z.literal("user_message_chunk") }).readonly(),
    z.object({ ...contentChunkFields, sessionUpdate: z.literal("agent_message_chunk") }).readonly(),
    z
        .object({
            ...contentChunkFields,
            meta: z.object({ truncated: z.boolean().optional() }).readonly().optional(),
            sessionUpdate: z.literal("agent_thought_chunk"),
        })
        .readonly(),
    z
        .object({
            backgroundTask: backgroundTaskSchema.optional(),
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
    z.object({ ...toolPatchFields, sessionUpdate: z.literal("tool_call_update"), toolCallId: shortString }).readonly(),
    z
        .object({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("plan"),
        })
        .readonly(),
    z.object({ plan: planContentSchema, sessionUpdate: z.literal("plan_update") }).readonly(),
    z.object({ planId: shortString, sessionUpdate: z.literal("plan_removed") }).readonly(),
    z
        .object({
            availableCommands: z.array(commandSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("available_commands_update"),
        })
        .readonly(),
    z
        .object({
            currentModeId: shortString,
            sessionUpdate: z.literal("current_mode_update"),
        })
        .readonly(),
    z
        .object({
            configOptions: z.array(sessionConfigOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("config_option_update"),
        })
        .readonly(),
    z
        .object({
            sessionUpdate: z.literal("session_info_update"),
            title: boundedString.nullable().optional(),
            updatedAt: shortString.nullable().optional(),
        })
        .readonly(),
    z
        .object({
            cost: z
                .object({ amount: z.number().finite(), currency: z.string().max(16) })
                .readonly()
                .nullable()
                .optional(),
            sessionUpdate: z.literal("usage_update"),
            size: z.number().int().nonnegative().safe(),
            used: z.number().int().nonnegative().safe(),
        })
        .readonly(),
    z
        .object({
            compactionId: shortString,
            error: boundedString.nullable().optional(),
            sessionUpdate: z.literal("compaction_update"),
            status: shortString,
            summary: z.array(contentBlockSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
        })
        .readonly(),
    z
        .object({
            compactionId: shortString,
            content: contentBlockSchema,
            sessionUpdate: z.literal("compaction_summary_chunk"),
        })
        .readonly(),
]);
export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

const lifecycleBase = { commandId: identifier };
export interface PromptExecutionContext {
    readonly agentId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
}
const promptExecutionContextSchema: z.ZodType<PromptExecutionContext> = z
    .object({
        agentId: identifier,
        directoryId: DIRECTORY_IDENTIFIER,
        additionalDirectoryIds: z.array(DIRECTORY_IDENTIFIER).max(16).readonly(),
    })
    .readonly();

export const lifecycleMetadataSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session.queue.changed") }).readonly(),
    z
        .object({ event: sessionPermissionRequestedEventSchema, kind: z.literal("session.permission.requested") })
        .readonly(),
    z
        .object({ event: sessionPermissionResolvedEventSchema, kind: z.literal("session.permission.resolved") })
        .readonly(),
    z
        .object({ event: sessionElicitationRequestedEventSchema, kind: z.literal("session.elicitation.requested") })
        .readonly(),
    z
        .object({ event: sessionElicitationResolvedEventSchema, kind: z.literal("session.elicitation.resolved") })
        .readonly(),
    z
        .object({
            ...lifecycleBase,
            content: z.array(contentBlockSchema).min(1).max(100).readonly(),
            disposition: shortString.optional(),
            kind: z.literal("prompt.requested"),
            context: promptExecutionContextSchema.optional(),
            targetCommandId: identifier.optional(),
        })
        .readonly(),
    z
        .object({ ...lifecycleBase, attemptId: identifier, epoch: identifier, kind: z.literal("prompt.started") })
        .readonly(),
    z.object({ ...lifecycleBase, kind: z.literal("prompt.completed"), stopReason: shortString }).readonly(),
    z
        .object({
            ...lifecycleBase,
            code: identifier,
            kind: z.literal("prompt.failed-before-start"),
            message: z.string().min(1).max(500),
        })
        .readonly(),
    z
        .object({
            ...lifecycleBase,
            attemptId: identifier,
            code: identifier,
            kind: z.literal("prompt.failed"),
            message: z.string().min(1).max(500),
        })
        .readonly(),
]);
export type LifecycleMetadata = z.infer<typeof lifecycleMetadataSchema>;
export const sessionEventPayloadSchema = z.discriminatedUnion("type", [
    z.object({ payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z.object({ payload: lifecycleMetadataSchema, type: z.literal("lifecycle-metadata") }).readonly(),
]);
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
const positionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const sharedSessionEventFields = {
    eventId: identifier,
    mobiusMetadata: z
        .object({ omitted: z.literal(true).optional() })
        .readonly()
        .optional(),
    recordedAt: z.iso.datetime({ offset: true }),
    sessionGenerationId: identifier,
    sessionId: identifier,
};
const sessionLiveEventFields = { ...sharedSessionEventFields, position: positionSchema };
export const sessionEventSchema = z.discriminatedUnion("type", [
    z.object({ ...sharedSessionEventFields, payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z
        .object({
            ...sharedSessionEventFields,
            payload: lifecycleMetadataSchema,
            type: z.literal("lifecycle-metadata"),
        })
        .readonly(),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export const sessionLiveEventSchema = z.discriminatedUnion("type", [
    z.object({ ...sessionLiveEventFields, payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z
        .object({
            ...sessionLiveEventFields,
            payload: lifecycleMetadataSchema,
            type: z.literal("lifecycle-metadata"),
        })
        .readonly(),
]);
export type SessionLiveEvent = z.infer<typeof sessionLiveEventSchema>;
export const sessionEventBatchSchema = z.array(sessionEventSchema).min(1).max(SESSION_EVENT_BATCH_MAX_SIZE).readonly();
export type SessionEventBatch = z.infer<typeof sessionEventBatchSchema>;
export const sessionLiveEventBatchSchema = z
    .array(sessionLiveEventSchema)
    .min(1)
    .max(SESSION_EVENT_BATCH_MAX_SIZE)
    .readonly();
export type SessionLiveEventBatch = z.infer<typeof sessionLiveEventBatchSchema>;
const sessionExportSchema = z
    .object({
        binding: z
            .object({
                bindingId: identifier,
                runtimeId: identifier,
            })
            .readonly(),
        events: z.array(sessionEventSchema).max(MAX_EVENT_COUNT).readonly(),
        sessionId: identifier,
        truncated: z.boolean(),
    })
    .readonly()
    .superRefine((session, context) => {
        const eventIds = new Set<string>();
        for (const [index, event] of session.events.entries()) {
            if (event.sessionId !== session.sessionId) {
                context.addIssue({
                    code: "custom",
                    message: "Exported event belongs to a different Session",
                    path: ["events", index, "sessionId"],
                });
            }
            if (eventIds.has(event.eventId)) {
                context.addIssue({
                    code: "custom",
                    message: "Exported event identities are not unique",
                    path: ["events", index, "eventId"],
                });
            }
            eventIds.add(event.eventId);
        }
    });
export const mobiusSessionExportSchema = z
    .object({
        formatVersion: z.literal("2"),
        session: sessionExportSchema,
    })
    .readonly();
export type MobiusSessionExport = z.infer<typeof mobiusSessionExportSchema>;
export const sessionEventEnvelopeSchema = z
    .object({ events: sessionLiveEventBatchSchema, kind: z.literal(SESSION_EVENT_KIND) })
    .readonly();
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;
export const sessionEventLogPageSchema = z
    .object({
        events: z.array(sessionEventSchema).max(MAX_EVENT_COUNT).readonly(),
        nextCursor: z.string().min(1).max(512).nullable(),
        sessionGenerationId: identifier,
        tailCursor: z.string().max(512),
        // The generation-scoped live position covered by this snapshot, including
        // coalesced and omitted events. Absent only on older Runtime versions.
        throughPosition: positionSchema.optional(),
        truncated: z.boolean(),
        version: z.literal(2),
    })
    .readonly();
export type SessionEventLogPage = z.infer<typeof sessionEventLogPageSchema>;
/** @deprecated Accepted for wire compatibility only; reasoning is always included. */
export const sessionEventOmissionSchema = z.literal("agent-reasoning");
/** @deprecated Reasoning omission is no longer supported. */
export type SessionEventOmission = z.infer<typeof sessionEventOmissionSchema>;
export const nativeEventPageRequestSchema = z
    .object({
        cursor: z.string().min(1).max(512).nullable(),
        eventLimit: z.number().int().min(1).max(10_000),
        // Legacy callers may still send this option; readers must ignore it.
        omit: z.array(sessionEventOmissionSchema).max(1).readonly().optional(),
    })
    .readonly();
export type NativeEventPageRequest = z.infer<typeof nativeEventPageRequestSchema>;
const queuedPromptRequestEventLogSchema = z
    .object({
        commandId: identifier,
        content: z.array(contentBlockSchema).min(1).max(100).readonly(),
        disposition: shortString.optional(),
        targetCommandId: identifier.optional(),
    })
    .readonly();
export type QueuedPromptRequestEventLog = z.infer<typeof queuedPromptRequestEventLogSchema>;
export const nativeSessionEventsSchema = z
    .object({
        events: sessionEventLogPageSchema,
        queuedPromptRequests: z.array(queuedPromptRequestEventLogSchema).max(MAX_COLLECTION_SIZE).readonly(),
    })
    .readonly();
export type NativeSessionEvents = z.infer<typeof nativeSessionEventsSchema>;

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
export const decodeSessionEvent = (value: unknown): SessionEvent => decode(value, sessionEventSchema);
export const encodeSessionEvent = (value: SessionEvent): string => encode(value, sessionEventSchema);
export const decodeSessionLiveEvent = (value: unknown): SessionLiveEvent => decode(value, sessionLiveEventSchema);
export const encodeSessionLiveEvent = (value: SessionLiveEvent): string => encode(value, sessionLiveEventSchema);
export const decodeSessionEventBatch = (value: unknown): SessionEventBatch => decode(value, sessionEventBatchSchema);
export const encodeSessionEventBatch = (value: SessionEventBatch): string => encode(value, sessionEventBatchSchema);
export const decodeSessionLiveEventBatch = (value: unknown): SessionLiveEventBatch =>
    decode(value, sessionLiveEventBatchSchema);
export const encodeSessionLiveEventBatch = (value: SessionLiveEventBatch): string =>
    encode(value, sessionLiveEventBatchSchema);
export const decodeMobiusSessionExport = (value: unknown): MobiusSessionExport =>
    decode(value, mobiusSessionExportSchema);
export const encodeMobiusSessionExport = (value: MobiusSessionExport): string =>
    encode(value, mobiusSessionExportSchema);
export const decodeSessionEventEnvelope = (value: unknown): SessionEventEnvelope =>
    decode(value, sessionEventEnvelopeSchema);
export const encodeSessionEventEnvelope = (value: SessionEventEnvelope): string =>
    encode(value, sessionEventEnvelopeSchema);
export const decodeAcpSessionUpdate = (value: unknown): AcpSessionUpdate => decode(value, acpSessionUpdateSchema);
export const decodeSessionEventLogPage = (value: unknown): SessionEventLogPage =>
    decode(value, sessionEventLogPageSchema);
export const encodeSessionEventLogPage = (value: SessionEventLogPage): string =>
    encode(value, sessionEventLogPageSchema);
export const decodeNativeSessionEvents = (value: unknown): NativeSessionEvents =>
    decode(value, nativeSessionEventsSchema);
export const encodeNativeSessionEvents = (value: NativeSessionEvents): string =>
    encode(value, nativeSessionEventsSchema);
