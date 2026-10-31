import { z } from "zod";

import { DIRECTORY_IDENTIFIER } from "../../shared/directory.ts";
import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { configValueSchema, SHORT_TEXT } from "../shared/index.ts";

export const AGENT_SETTINGS_DISCOVER_KIND = "agent.settings.discover";
export const AGENT_SETTINGS_DISCOVERED_KIND = "agent.settings.discovered";
export const AGENT_SETTINGS_DISCOVERY_FAILED_KIND = "agent.settings.discovery.failed";

export const agentSettingSchema = z
    .object({
        booleanValue: z.boolean(),
        category: z.string().max(128),
        defaultValue: z.string().max(500),
        description: SHORT_TEXT,
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(255),
        type: z.enum(["boolean", "select"]),
        values: z.array(configValueSchema).max(500).readonly(),
    })
    .readonly();

export type AgentSetting = z.infer<typeof agentSettingSchema>;

const agentSettingsSchema = z.array(agentSettingSchema).max(128).readonly();

export const AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE = "complete";
export const AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION = "on_model_selection";
export const AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE = "unavailable";

const agentModelEffortResolutionSchema = z.enum([
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
]);

export const agentModelEffortSchema = z
    .object({
        effortSettingId: z.string().max(128),
        modelSettingId: z.string().max(128),
        resolution: agentModelEffortResolutionSchema,
        unsupportedModelIds: z.array(z.string().min(1).max(500)).max(500).readonly().default([]),
        valuesByModel: z.record(z.string().min(1).max(500), z.array(configValueSchema).max(500).readonly()).readonly(),
    })
    .readonly();

export type AgentModelEffort = z.infer<typeof agentModelEffortSchema>;

const agentSettingsDiscoverCommandSchema = z
    .object({
        agentId: IDENTIFIER,
        // The directory a Session would start in, whose project settings the Agent reads. Omitted, the Runtime's
        // default directory. A Runtime that predates this field ignores it; see the discovered event's `directoryId`.
        directoryId: DIRECTORY_IDENTIFIER.optional(),
        kind: z.literal(AGENT_SETTINGS_DISCOVER_KIND),
        model: z.string().min(1).max(500).optional(),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentSettingsDiscoverCommand = z.infer<typeof agentSettingsDiscoverCommandSchema>;

const agentSettingsDiscoveredEventSchema = z
    .object({
        agentId: IDENTIFIER,
        agentName: z.string().max(255),
        agentVersion: z.string().max(128),
        // The directory the settings were discovered in. Absent from older Runtimes, which always discover in the
        // Runtime's default directory whatever the command named.
        directoryId: DIRECTORY_IDENTIFIER.optional(),
        kind: z.literal(AGENT_SETTINGS_DISCOVERED_KIND),
        modelEffort: agentModelEffortSchema,
        requestId: IDENTIFIER,
        settings: agentSettingsSchema,
        settingsRevision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .readonly();

export type AgentSettingsDiscoveredEvent = z.infer<typeof agentSettingsDiscoveredEventSchema>;

const agentSettingsDiscoveryFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(AGENT_SETTINGS_DISCOVERY_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentSettingsDiscoveryFailedEvent = z.infer<typeof agentSettingsDiscoveryFailedEventSchema>;

export const decodeAgentSettingsDiscoverCommand = (encoded: string): AgentSettingsDiscoverCommand =>
    decode(encoded, agentSettingsDiscoverCommandSchema);
export const encodeAgentSettingsDiscoverCommand = (message: AgentSettingsDiscoverCommand): string =>
    encode(message, agentSettingsDiscoverCommandSchema);
export const decodeAgentSettingsDiscoveredEvent = (encoded: string): AgentSettingsDiscoveredEvent =>
    decode(encoded, agentSettingsDiscoveredEventSchema);
export const encodeAgentSettingsDiscoveredEvent = (message: AgentSettingsDiscoveredEvent): string =>
    encode(message, agentSettingsDiscoveredEventSchema);
export const decodeAgentSettingsDiscoveryFailedEvent = (encoded: string): AgentSettingsDiscoveryFailedEvent =>
    decode(encoded, agentSettingsDiscoveryFailedEventSchema);
export const encodeAgentSettingsDiscoveryFailedEvent = (message: AgentSettingsDiscoveryFailedEvent): string =>
    encode(message, agentSettingsDiscoveryFailedEventSchema);
