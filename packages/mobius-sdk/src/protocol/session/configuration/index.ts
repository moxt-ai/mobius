import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage, decodeZodValue, encodeZodMessage } from "../../shared/message-codec.ts";
import { configValueSchema, SHORT_TEXT, sessionIdentityFields } from "../shared/index.ts";

export const SESSION_CONFIGURE_KIND = "session.configure";
export const SESSION_CONFIG_UPDATED_KIND = "session.config.updated";

export const sessionConfigOptionSchema = z
    .object({
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

export type SessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;

export const sessionConfigOptionsSchema = z.array(sessionConfigOptionSchema).max(100).readonly();

export const sessionConfigurationSelectionSchema = z
    .object({
        booleanValue: z.boolean(),
        configId: IDENTIFIER,
        value: z.string().max(500),
        valueType: z.enum(["boolean", "select"]),
    })
    .readonly();

export type SessionConfigurationSelection = z.infer<typeof sessionConfigurationSelectionSchema>;

export const AGENT_DEFAULT_EXECUTION_SETTING = "agent_default";
export const AGENT_PERMISSION_MODE_CONFIG_ID = "permission_mode";
export const AGENT_PERMISSION_MODES: readonly string[] = Object.freeze([
    AGENT_DEFAULT_EXECUTION_SETTING,
    "read-only",
    "workspace-write",
    "danger-full-access",
]);

export const agentExecutionConfigurationSchema = z
    .object({
        model: sessionConfigurationSelectionSchema,
        permissionMode: z.string().refine((value) => AGENT_PERMISSION_MODES.includes(value)),
        reasoningEffort: sessionConfigurationSelectionSchema,
    })
    .superRefine((configuration, context) => {
        if (
            configuration.model.valueType !== "select" ||
            configuration.model.booleanValue ||
            configuration.model.value.length === 0 ||
            configuration.reasoningEffort.valueType !== "select" ||
            configuration.reasoningEffort.booleanValue ||
            configuration.reasoningEffort.value.length === 0
        ) {
            context.addIssue({
                code: "custom",
                message: "Model and reasoning effort must be explicit select configurations",
            });
        }
        if (
            configuration.model.configId === configuration.reasoningEffort.configId ||
            configuration.model.configId === AGENT_PERMISSION_MODE_CONFIG_ID ||
            configuration.reasoningEffort.configId === AGENT_PERMISSION_MODE_CONFIG_ID
        ) {
            context.addIssue({
                code: "custom",
                message: "Required execution setting identifiers must differ",
            });
        }
    })
    .readonly();

export type AgentExecutionConfiguration = z.infer<typeof agentExecutionConfigurationSchema>;

function agentDefaultSelection(configId: string): SessionConfigurationSelection {
    return Object.freeze({
        booleanValue: false,
        configId,
        value: AGENT_DEFAULT_EXECUTION_SETTING,
        valueType: "select",
    });
}

export const DEFAULT_AGENT_EXECUTION_CONFIGURATION: AgentExecutionConfiguration = Object.freeze({
    model: agentDefaultSelection("model"),
    permissionMode: AGENT_DEFAULT_EXECUTION_SETTING,
    reasoningEffort: agentDefaultSelection("reasoning_effort"),
});

export const sessionConfigurationSelectionsSchema = z
    .array(sessionConfigurationSelectionSchema)
    .max(100)
    .superRefine((selections, context) => {
        const identifiers = new Set<string>();
        for (const [index, selection] of selections.entries()) {
            if (identifiers.has(selection.configId)) {
                context.addIssue({
                    code: "custom",
                    message: "Session configuration identifiers must be unique",
                    path: [index, "configId"],
                });
            }
            identifiers.add(selection.configId);
        }
    })
    .readonly();

const sessionConfigureCommandSchema = z
    .object({
        ...sessionIdentityFields,
        booleanValue: z.boolean(),
        configId: z.string().min(1).max(128),
        expectedConfigurationRevision: IDENTIFIER,
        kind: z.literal(SESSION_CONFIGURE_KIND),
        requestId: IDENTIFIER,
        value: z.string().max(500),
        valueType: z.enum(["boolean", "select"]),
    })
    .readonly();

export type SessionConfigureCommand = z.infer<typeof sessionConfigureCommandSchema>;

const sessionConfigUpdatedEventSchema = z
    .object({
        configOptions: sessionConfigOptionsSchema,
        // An opaque Runtime generation token.
        configurationRevision: IDENTIFIER,
        kind: z.literal(SESSION_CONFIG_UPDATED_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionConfigUpdatedEvent = z.infer<typeof sessionConfigUpdatedEventSchema>;

export const decodeSessionConfigurationSelections = (value: unknown): readonly SessionConfigurationSelection[] =>
    decodeZodValue(value, sessionConfigurationSelectionsSchema);

export const decodeAgentExecutionConfiguration = (value: unknown): AgentExecutionConfiguration =>
    decodeZodValue(value, agentExecutionConfigurationSchema);

export const decodeSessionConfigOptions = (value: unknown): readonly SessionConfigOption[] =>
    decodeZodValue(value, sessionConfigOptionsSchema);

export const decodeSessionConfigureCommand = (encoded: string): SessionConfigureCommand =>
    decodeZodMessage(encoded, sessionConfigureCommandSchema);
export const encodeSessionConfigureCommand = (message: SessionConfigureCommand): string =>
    encodeZodMessage(message, sessionConfigureCommandSchema);
export const decodeSessionConfigUpdatedEvent = (encoded: string): SessionConfigUpdatedEvent =>
    decodeZodMessage(encoded, sessionConfigUpdatedEventSchema);
export const encodeSessionConfigUpdatedEvent = (message: SessionConfigUpdatedEvent): string =>
    encodeZodMessage(message, sessionConfigUpdatedEventSchema);

export const SESSION_CONFIG_READ_KIND = "session.config.read";
export const SESSION_CONFIG_READ_RESULT_KIND = "session.config.read.result";

const sessionConfigReadCommandSchema = z
    .object({
        kind: z.literal(SESSION_CONFIG_READ_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionConfigReadCommand = z.infer<typeof sessionConfigReadCommandSchema>;

const sessionConfigReadResultSchema = z
    .object({
        configOptions: sessionConfigOptionsSchema,
        // An opaque Runtime generation token.
        configurationRevision: IDENTIFIER,
        kind: z.literal(SESSION_CONFIG_READ_RESULT_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
    })
    .readonly();

export type SessionConfigReadResult = z.infer<typeof sessionConfigReadResultSchema>;

export const decodeSessionConfigReadCommand = (encoded: string): SessionConfigReadCommand =>
    decodeZodMessage(encoded, sessionConfigReadCommandSchema);
export const encodeSessionConfigReadCommand = (message: SessionConfigReadCommand): string =>
    encodeZodMessage(message, sessionConfigReadCommandSchema);
export const decodeSessionConfigReadResult = (encoded: string): SessionConfigReadResult =>
    decodeZodMessage(encoded, sessionConfigReadResultSchema);
export const encodeSessionConfigReadResult = (message: SessionConfigReadResult): string =>
    encodeZodMessage(message, sessionConfigReadResultSchema);
