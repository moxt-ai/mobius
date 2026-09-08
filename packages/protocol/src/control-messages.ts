import { z } from "zod";

import { ProtocolMessageError } from "./codecs/messages.ts";
import { promptMetadataSchema, promptUsageSchema } from "./prompt-usage.ts";

export const WORKSPACE_LIST_KIND = "workspace.list";
export const WORKSPACE_ENTRIES_KIND = "workspace.entries";
export const SESSION_PREPARE_KIND = "session.prepare";
export const SESSION_READY_KIND = "session.ready";
export const SESSION_CONFIGURE_KIND = "session.configure";
export const SESSION_CONFIG_UPDATED_KIND = "session.config.updated";
export const SESSION_USAGE_UPDATED_KIND = "session.usage.updated";
export const SESSION_COMMANDS_UPDATED_KIND = "session.commands.updated";
export const SESSION_INFO_UPDATED_KIND = "session.info.updated";
export const SESSION_PERMISSION_REQUESTED_KIND = "session.permission.requested";
export const SESSION_PERMISSION_RESPOND_KIND = "session.permission.respond";
export const SESSION_PERMISSION_RESOLVED_KIND = "session.permission.resolved";
export const SESSION_ELICITATION_REQUESTED_KIND = "session.elicitation.requested";
export const SESSION_ELICITATION_RESPOND_KIND = "session.elicitation.respond";
export const SESSION_ELICITATION_RESOLVED_KIND = "session.elicitation.resolved";
export const SESSION_OPERATION_FAILED_KIND = "session.operation.failed";
export const AGENT_CONTENT_KIND = "agent.content";
export const AGENT_INSTALL_REQUEST_KIND = "agent.integration.install.request";
export const AGENT_INSTALL_CANCEL_KIND = "agent.integration.install.cancel";
export const AGENT_INSTALL_STARTED_KIND = "agent.integration.install.started";
export const AGENT_INSTALL_PROGRESS_KIND = "agent.integration.install.progress";
export const AGENT_INSTALL_COMPLETED_KIND = "agent.integration.install.completed";
export const AGENT_INSTALL_FAILED_KIND = "agent.integration.install.failed";
export const AGENT_INSTALL_CANCELLED_KIND = "agent.integration.install.cancelled";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const IDENTIFIER = z.string().min(1).max(128).regex(IDENTIFIER_PATTERN);
const DIRECTORY_IDENTIFIER = z.string().min(1).max(2_048).regex(DIRECTORY_IDENTIFIER_PATTERN);
const SHORT_TEXT = z.string().max(500);
const LONG_TEXT = z.string().max(100_000);

const workspaceEntrySchema = z
    .strictObject({
        directoryId: DIRECTORY_IDENTIFIER,
        name: z.string().min(1).max(255),
    })
    .readonly();

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

const configValueSchema = z
    .strictObject({
        description: SHORT_TEXT,
        groupId: z.string().max(128),
        groupName: z.string().max(255),
        name: z.string().min(1).max(255),
        value: z.string().min(1).max(500),
    })
    .readonly();

export type SessionConfigValue = z.infer<typeof configValueSchema>;

const configOptionSchema = z
    .strictObject({
        booleanValue: z.boolean(),
        category: z.string().max(128),
        currentValue: z.string().max(500),
        description: SHORT_TEXT,
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(255),
        type: z.enum(["boolean", "select"]),
        values: z.array(configValueSchema).max(500).readonly(),
    })
    .readonly();

export type SessionConfigOption = z.infer<typeof configOptionSchema>;

export const sessionCapabilitiesSchema = z
    .strictObject({
        additionalDirectories: z.boolean(),
        audioPrompt: z.boolean(),
        closeSession: z.boolean(),
        deleteSession: z.boolean(),
        embeddedContextPrompt: z.boolean(),
        imagePrompt: z.boolean(),
        listSessions: z.boolean(),
        loadSession: z.boolean(),
        resumeSession: z.boolean(),
        unstableForkSession: z.boolean().default(false),
    })
    .readonly();

export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;

const sessionCommandSchema = z
    .strictObject({
        description: SHORT_TEXT,
        inputHint: z.string().max(255),
        name: z.string().min(1).max(128),
    })
    .readonly();

export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export const permissionOptionSchema = z
    .strictObject({
        kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
        name: z.string().min(1).max(255),
        optionId: z.string().min(1).max(255),
    })
    .readonly();

export type SessionPermissionOption = z.infer<typeof permissionOptionSchema>;

const elicitationOptionSchema = z
    .strictObject({
        description: SHORT_TEXT,
        label: z.string().min(1).max(255),
        value: z.string().max(500),
    })
    .readonly();

export type SessionElicitationOption = z.infer<typeof elicitationOptionSchema>;

export const elicitationFieldSchema = z
    .strictObject({
        defaultBooleanValue: z.boolean(),
        defaultNumberValue: z.number().finite(),
        defaultStringValue: z.string().max(10_000),
        description: SHORT_TEXT,
        format: z.string().max(64),
        hasDefaultValue: z.boolean(),
        maximum: z.string().max(128),
        maximumLength: z.string().max(128),
        minimum: z.string().max(128),
        minimumLength: z.string().max(128),
        name: z.string().min(1).max(128),
        options: z.array(elicitationOptionSchema).max(200).readonly(),
        pattern: z.string().max(500),
        required: z.boolean(),
        title: z.string().min(1).max(255),
        type: z.enum(["boolean", "integer", "multiselect", "number", "select", "string"]),
    })
    .readonly();

export type SessionElicitationField = z.infer<typeof elicitationFieldSchema>;

const displayContentSchema = z
    .strictObject({
        data: z.string().max(4_000_000),
        mimeType: z.string().max(255),
        name: z.string().max(500),
        newText: LONG_TEXT,
        oldText: LONG_TEXT,
        path: z.string().max(2_048),
        terminalId: z.string().max(255),
        text: LONG_TEXT,
        type: z.enum(["diff", "image", "resource", "resource_link", "terminal", "text"]),
        uri: z.string().max(4_096),
    })
    .readonly();

export type AgentDisplayContent = z.infer<typeof displayContentSchema>;

const recordedDisplayContentSchema = z
    .strictObject({
        data: z.string().max(4_000_000),
        mimeType: z.string().max(255),
        name: z.string().max(500),
        newText: z.string().max(4_000_000),
        oldText: z.string().max(4_000_000),
        path: z.string().max(2_048),
        terminalId: z.string().max(255),
        text: z.string().max(4_000_000),
        type: z.enum(["diff", "image", "resource", "resource_link", "terminal", "text"]),
        uri: z.string().max(4_096),
    })
    .readonly();

const promptImageSchema = z
    .strictObject({
        data: z.string().min(1).max(4_000_000),
        mimeType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
    })
    .readonly();

export type PromptImage = z.infer<typeof promptImageSchema>;

const promptResourceSchema = z
    .strictObject({
        mimeType: z.string().max(255),
        name: z.string().min(1).max(500),
        text: z.string().max(1_000_000),
        type: z.enum(["embedded", "link"]),
        uri: z.string().min(1).max(4_096),
    })
    .readonly();

export type PromptResource = z.infer<typeof promptResourceSchema>;

const workspaceListCommandSchema = z
    .strictObject({
        bindingId: IDENTIFIER,
        directoryId: DIRECTORY_IDENTIFIER,
        kind: z.literal(WORKSPACE_LIST_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type WorkspaceListCommand = z.infer<typeof workspaceListCommandSchema>;

const workspaceEntriesEventSchema = z
    .strictObject({
        bindingId: IDENTIFIER,
        directoryId: DIRECTORY_IDENTIFIER,
        directoryLabel: z.string().min(1).max(2_048),
        entries: z.array(workspaceEntrySchema).max(500).readonly(),
        kind: z.literal(WORKSPACE_ENTRIES_KIND),
        parentDirectoryId: z.string().max(2_048),
        requestId: IDENTIFIER,
    })
    .readonly();

export type WorkspaceEntriesEvent = z.infer<typeof workspaceEntriesEventSchema>;

const sessionIdentityFields = {
    additionalDirectoryIds: z.array(DIRECTORY_IDENTIFIER).max(16).readonly(),
    agentId: IDENTIFIER,
    bindingId: IDENTIFIER,
    directoryId: DIRECTORY_IDENTIFIER,
    sessionId: IDENTIFIER,
};

const sessionPrepareCommandSchema = z
    .strictObject({
        ...sessionIdentityFields,
        kind: z.literal(SESSION_PREPARE_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionPrepareCommand = z.infer<typeof sessionPrepareCommandSchema>;

export const sessionReadyEventSchema = z
    .strictObject({
        additionalDirectories: z.array(workspaceEntrySchema).max(16).readonly(),
        agentId: IDENTIFIER,
        agentName: z.string().max(255),
        agentVersion: z.string().max(128),
        capabilities: sessionCapabilitiesSchema,
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        configOptions: z.array(configOptionSchema).max(100).readonly(),
        directoryId: DIRECTORY_IDENTIFIER,
        directoryLabel: z.string().min(1).max(2_048),
        kind: z.literal(SESSION_READY_KIND),
        requestId: IDENTIFIER,
        restored: z.boolean(),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionReadyEvent = z.infer<typeof sessionReadyEventSchema>;

const sessionConfigureCommandSchema = z
    .strictObject({
        ...sessionIdentityFields,
        booleanValue: z.boolean(),
        configId: z.string().min(1).max(128),
        kind: z.literal(SESSION_CONFIGURE_KIND),
        requestId: IDENTIFIER,
        value: z.string().max(500),
        valueType: z.enum(["boolean", "select"]),
    })
    .readonly();

export type SessionConfigureCommand = z.infer<typeof sessionConfigureCommandSchema>;

const sessionConfigUpdatedEventSchema = z
    .strictObject({
        configOptions: z.array(configOptionSchema).max(100).readonly(),
        kind: z.literal(SESSION_CONFIG_UPDATED_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionConfigUpdatedEvent = z.infer<typeof sessionConfigUpdatedEventSchema>;

const sessionContextUsageUpdatedEventSchema = z
    .strictObject({
        costAmount: z.number().finite().nonnegative(),
        costCurrency: z.string().max(16),
        hasCost: z.boolean(),
        kind: z.literal(SESSION_USAGE_UPDATED_KIND),
        sessionId: IDENTIFIER,
        size: z.number().int().nonnegative(),
        source: z.literal("context").default("context"),
        used: z.number().int().nonnegative(),
    })
    .readonly();

export type SessionContextUsageUpdatedEvent = z.infer<typeof sessionContextUsageUpdatedEventSchema>;

const sessionPromptUsageUpdatedEventSchema = z
    .strictObject({
        _meta: promptMetadataSchema.nullable(),
        commandId: IDENTIFIER,
        kind: z.literal(SESSION_USAGE_UPDATED_KIND),
        sessionId: IDENTIFIER,
        source: z.literal("prompt"),
        usage: promptUsageSchema.nullable(),
    })
    .refine((event) => event.usage !== null || event._meta?.quota !== undefined)
    .readonly();

export type SessionPromptUsageUpdatedEvent = z.infer<typeof sessionPromptUsageUpdatedEventSchema>;

// The context branch accepts pre-P0 history without a source discriminator.
const sessionUsageUpdatedEventSchema = z.union([
    sessionContextUsageUpdatedEventSchema,
    sessionPromptUsageUpdatedEventSchema,
]);

export type SessionUsageUpdatedEvent = z.infer<typeof sessionUsageUpdatedEventSchema>;

const sessionCommandsUpdatedEventSchema = z
    .strictObject({
        commands: z.array(sessionCommandSchema).max(500).readonly(),
        kind: z.literal(SESSION_COMMANDS_UPDATED_KIND),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionCommandsUpdatedEvent = z.infer<typeof sessionCommandsUpdatedEventSchema>;

const sessionInfoUpdatedEventSchema = z
    .strictObject({
        kind: z.literal(SESSION_INFO_UPDATED_KIND),
        sessionId: IDENTIFIER,
        title: z.string().max(500).nullable(),
        updatedAt: z.string().max(128),
    })
    .readonly();

export type SessionInfoUpdatedEvent = z.infer<typeof sessionInfoUpdatedEventSchema>;

const sessionPermissionRequestedEventSchema = z
    .strictObject({
        commandId: IDENTIFIER,
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_REQUESTED_KIND),
        options: z.array(permissionOptionSchema).min(1).max(20).readonly(),
        sessionId: IDENTIFIER,
        title: z.string().min(1).max(500),
        toolCallId: z.string().min(1).max(255),
        toolKind: z.string().max(64),
    })
    .readonly();

export type SessionPermissionRequestedEvent = z.infer<typeof sessionPermissionRequestedEventSchema>;

const sessionPermissionRespondCommandSchema = z
    .strictObject({
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_RESPOND_KIND),
        optionId: z.string().max(255),
        outcome: z.enum(["cancelled", "selected"]),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionPermissionRespondCommand = z.infer<typeof sessionPermissionRespondCommandSchema>;

const sessionPermissionResolvedEventSchema = z
    .strictObject({
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_RESOLVED_KIND),
        optionId: z.string().max(255),
        outcome: z.enum(["cancelled", "selected"]),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionPermissionResolvedEvent = z.infer<typeof sessionPermissionResolvedEventSchema>;

const sessionElicitationRequestedEventSchema = z
    .strictObject({
        accepted: z.boolean(),
        commandId: IDENTIFIER,
        elicitationId: z.string().max(255),
        fields: z.array(elicitationFieldSchema).max(100).readonly(),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_REQUESTED_KIND),
        message: z.string().min(1).max(2_000),
        mode: z.enum(["form", "url"]),
        sessionId: IDENTIFIER,
        url: z.string().max(4_096),
    })
    .readonly();

export type SessionElicitationRequestedEvent = z.infer<typeof sessionElicitationRequestedEventSchema>;

const sessionElicitationRespondCommandSchema = z
    .strictObject({
        action: z.enum(["accept", "cancel", "decline"]),
        content: z.string().max(100_000),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_RESPOND_KIND),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionElicitationRespondCommand = z.infer<typeof sessionElicitationRespondCommandSchema>;

const sessionElicitationResolvedEventSchema = z
    .strictObject({
        action: z.enum(["accept", "cancel", "decline", "complete"]),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_RESOLVED_KIND),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionElicitationResolvedEvent = z.infer<typeof sessionElicitationResolvedEventSchema>;

const sessionOperationFailedEventSchema = z
    .strictObject({
        code: IDENTIFIER,
        kind: z.literal(SESSION_OPERATION_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        sessionId: z.string().max(128),
    })
    .readonly();

export type SessionOperationFailedEvent = z.infer<typeof sessionOperationFailedEventSchema>;

const agentContentEventSchema = z
    .strictObject({
        commandId: IDENTIFIER,
        content: displayContentSchema,
        contentId: IDENTIFIER,
        kind: z.literal(AGENT_CONTENT_KIND),
        messageId: z.string().max(255),
        sessionId: IDENTIFIER,
    })
    .readonly();

export type AgentContentEvent = z.infer<typeof agentContentEventSchema>;

const agentInstallIdentityFields = {
    agentId: IDENTIFIER,
    requestId: IDENTIFIER,
};

const agentInstallRequestCommandSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        kind: z.literal(AGENT_INSTALL_REQUEST_KIND),
    })
    .readonly();

export type AgentInstallRequestCommand = z.infer<typeof agentInstallRequestCommandSchema>;

const agentInstallCancelCommandSchema = z
    .strictObject({
        kind: z.literal(AGENT_INSTALL_CANCEL_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentInstallCancelCommand = z.infer<typeof agentInstallCancelCommandSchema>;

const agentInstallStartedEventSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        kind: z.literal(AGENT_INSTALL_STARTED_KIND),
    })
    .readonly();

export type AgentInstallStartedEvent = z.infer<typeof agentInstallStartedEventSchema>;

const installationStageSchema = z.enum([
    "downloading",
    "verifying",
    "installing_agent",
    "installing_adapter",
    "checking_acp",
]);

export type AgentInstallationStage = z.infer<typeof installationStageSchema>;

const agentInstallProgressEventSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        kind: z.literal(AGENT_INSTALL_PROGRESS_KIND),
        stage: installationStageSchema,
    })
    .readonly();

export type AgentInstallProgressEvent = z.infer<typeof agentInstallProgressEventSchema>;

const agentInstallCompletedEventSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        authenticationMayBeRequired: z.boolean(),
        kind: z.literal(AGENT_INSTALL_COMPLETED_KIND),
    })
    .readonly();

export type AgentInstallCompletedEvent = z.infer<typeof agentInstallCompletedEventSchema>;

const agentInstallFailedEventSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        code: IDENTIFIER,
        kind: z.literal(AGENT_INSTALL_FAILED_KIND),
        message: z.string().min(1).max(500),
    })
    .readonly();

export type AgentInstallFailedEvent = z.infer<typeof agentInstallFailedEventSchema>;

const agentInstallCancelledEventSchema = z
    .strictObject({
        ...agentInstallIdentityFields,
        kind: z.literal(AGENT_INSTALL_CANCELLED_KIND),
    })
    .readonly();

export type AgentInstallCancelledEvent = z.infer<typeof agentInstallCancelledEventSchema>;

function parseJson(encoded: string): unknown {
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new ProtocolMessageError("Message is not valid JSON", {
            cause: error,
        });
    }
}

function decode<T>(encoded: string, schema: z.ZodType<T>): T {
    const result = schema.safeParse(parseJson(encoded));
    if (!result.success) {
        throw new ProtocolMessageError("Message does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}

function decodeValue<T>(value: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new ProtocolMessageError("Message field does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}

export const decodeAgentDisplayContentValue = (value: unknown): AgentDisplayContent =>
    decodeValue(value, displayContentSchema);

export const decodeRecordedAgentContentValue = (value: unknown): AgentDisplayContent =>
    decodeValue(value, recordedDisplayContentSchema);

export const decodePromptImagesValue = (value: unknown): readonly PromptImage[] =>
    decodeValue(value, z.array(promptImageSchema).max(8).readonly());

export const decodePromptResourcesValue = (value: unknown): readonly PromptResource[] =>
    decodeValue(value, z.array(promptResourceSchema).max(16).readonly());

const encode = <T>(message: T, schema: z.ZodType<T>): string => JSON.stringify(decodeValue(message, schema));

export const decodeWorkspaceListCommand = (encoded: string): WorkspaceListCommand =>
    decode(encoded, workspaceListCommandSchema);
export const encodeWorkspaceListCommand = (message: WorkspaceListCommand): string =>
    encode(message, workspaceListCommandSchema);
export const decodeWorkspaceEntriesEvent = (encoded: string): WorkspaceEntriesEvent =>
    decode(encoded, workspaceEntriesEventSchema);
export const encodeWorkspaceEntriesEvent = (message: WorkspaceEntriesEvent): string =>
    encode(message, workspaceEntriesEventSchema);
export const decodeSessionPrepareCommand = (encoded: string): SessionPrepareCommand =>
    decode(encoded, sessionPrepareCommandSchema);
export const encodeSessionPrepareCommand = (message: SessionPrepareCommand): string =>
    encode(message, sessionPrepareCommandSchema);
export const decodeSessionReadyEvent = (encoded: string): SessionReadyEvent => decode(encoded, sessionReadyEventSchema);
export const encodeSessionReadyEvent = (message: SessionReadyEvent): string => encode(message, sessionReadyEventSchema);
export const decodeSessionConfigureCommand = (encoded: string): SessionConfigureCommand =>
    decode(encoded, sessionConfigureCommandSchema);
export const encodeSessionConfigureCommand = (message: SessionConfigureCommand): string =>
    encode(message, sessionConfigureCommandSchema);
export const decodeSessionConfigUpdatedEvent = (encoded: string): SessionConfigUpdatedEvent =>
    decode(encoded, sessionConfigUpdatedEventSchema);
export const encodeSessionConfigUpdatedEvent = (message: SessionConfigUpdatedEvent): string =>
    encode(message, sessionConfigUpdatedEventSchema);
export const decodeSessionUsageUpdatedEvent = (encoded: string): SessionUsageUpdatedEvent =>
    decode(encoded, sessionUsageUpdatedEventSchema);
export const encodeSessionUsageUpdatedEvent = (message: SessionUsageUpdatedEvent): string =>
    encode(message, sessionUsageUpdatedEventSchema);
export const decodeSessionCommandsUpdatedEvent = (encoded: string): SessionCommandsUpdatedEvent =>
    decode(encoded, sessionCommandsUpdatedEventSchema);
export const encodeSessionCommandsUpdatedEvent = (message: SessionCommandsUpdatedEvent): string =>
    encode(message, sessionCommandsUpdatedEventSchema);
export const decodeSessionInfoUpdatedEvent = (encoded: string): SessionInfoUpdatedEvent =>
    decode(encoded, sessionInfoUpdatedEventSchema);
export const encodeSessionInfoUpdatedEvent = (message: SessionInfoUpdatedEvent): string =>
    encode(message, sessionInfoUpdatedEventSchema);
export const decodeSessionPermissionRequestedEvent = (encoded: string): SessionPermissionRequestedEvent =>
    decode(encoded, sessionPermissionRequestedEventSchema);
export const encodeSessionPermissionRequestedEvent = (message: SessionPermissionRequestedEvent): string =>
    encode(message, sessionPermissionRequestedEventSchema);
export const decodeSessionPermissionRespondCommand = (encoded: string): SessionPermissionRespondCommand =>
    decode(encoded, sessionPermissionRespondCommandSchema);
export const encodeSessionPermissionRespondCommand = (message: SessionPermissionRespondCommand): string =>
    encode(message, sessionPermissionRespondCommandSchema);
export const decodeSessionPermissionResolvedEvent = (encoded: string): SessionPermissionResolvedEvent =>
    decode(encoded, sessionPermissionResolvedEventSchema);
export const encodeSessionPermissionResolvedEvent = (message: SessionPermissionResolvedEvent): string =>
    encode(message, sessionPermissionResolvedEventSchema);
export const decodeSessionElicitationRequestedEvent = (encoded: string): SessionElicitationRequestedEvent =>
    decode(encoded, sessionElicitationRequestedEventSchema);
export const encodeSessionElicitationRequestedEvent = (message: SessionElicitationRequestedEvent): string =>
    encode(message, sessionElicitationRequestedEventSchema);
export const decodeSessionElicitationRespondCommand = (encoded: string): SessionElicitationRespondCommand =>
    decode(encoded, sessionElicitationRespondCommandSchema);
export const encodeSessionElicitationRespondCommand = (message: SessionElicitationRespondCommand): string =>
    encode(message, sessionElicitationRespondCommandSchema);
export const decodeSessionElicitationResolvedEvent = (encoded: string): SessionElicitationResolvedEvent =>
    decode(encoded, sessionElicitationResolvedEventSchema);
export const encodeSessionElicitationResolvedEvent = (message: SessionElicitationResolvedEvent): string =>
    encode(message, sessionElicitationResolvedEventSchema);
export const decodeSessionOperationFailedEvent = (encoded: string): SessionOperationFailedEvent =>
    decode(encoded, sessionOperationFailedEventSchema);
export const encodeSessionOperationFailedEvent = (message: SessionOperationFailedEvent): string =>
    encode(message, sessionOperationFailedEventSchema);
export const decodeAgentContentEvent = (encoded: string): AgentContentEvent => decode(encoded, agentContentEventSchema);
export const encodeAgentContentEvent = (message: AgentContentEvent): string => encode(message, agentContentEventSchema);
export const decodeAgentInstallRequestCommand = (encoded: string): AgentInstallRequestCommand =>
    decode(encoded, agentInstallRequestCommandSchema);
export const encodeAgentInstallRequestCommand = (message: AgentInstallRequestCommand): string =>
    encode(message, agentInstallRequestCommandSchema);
export const decodeAgentInstallCancelCommand = (encoded: string): AgentInstallCancelCommand =>
    decode(encoded, agentInstallCancelCommandSchema);
export const encodeAgentInstallCancelCommand = (message: AgentInstallCancelCommand): string =>
    encode(message, agentInstallCancelCommandSchema);
export const decodeAgentInstallStartedEvent = (encoded: string): AgentInstallStartedEvent =>
    decode(encoded, agentInstallStartedEventSchema);
export const encodeAgentInstallStartedEvent = (message: AgentInstallStartedEvent): string =>
    encode(message, agentInstallStartedEventSchema);
export const decodeAgentInstallProgressEvent = (encoded: string): AgentInstallProgressEvent =>
    decode(encoded, agentInstallProgressEventSchema);
export const encodeAgentInstallProgressEvent = (message: AgentInstallProgressEvent): string =>
    encode(message, agentInstallProgressEventSchema);
export const decodeAgentInstallCompletedEvent = (encoded: string): AgentInstallCompletedEvent =>
    decode(encoded, agentInstallCompletedEventSchema);
export const encodeAgentInstallCompletedEvent = (message: AgentInstallCompletedEvent): string =>
    encode(message, agentInstallCompletedEventSchema);
export const decodeAgentInstallFailedEvent = (encoded: string): AgentInstallFailedEvent =>
    decode(encoded, agentInstallFailedEventSchema);
export const encodeAgentInstallFailedEvent = (message: AgentInstallFailedEvent): string =>
    encode(message, agentInstallFailedEventSchema);
export const decodeAgentInstallCancelledEvent = (encoded: string): AgentInstallCancelledEvent =>
    decode(encoded, agentInstallCancelledEventSchema);
export const encodeAgentInstallCancelledEvent = (message: AgentInstallCancelledEvent): string =>
    encode(message, agentInstallCancelledEventSchema);
