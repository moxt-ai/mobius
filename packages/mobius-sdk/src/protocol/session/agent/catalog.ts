import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";

export const AGENT_CATALOG_DISCOVER_KIND = "agent.catalog.discover";
export const AGENT_CATALOG_DISCOVERED_KIND = "agent.catalog.discovered";
export const AGENT_CATALOG_DISCOVERY_FAILED_KIND = "agent.catalog.discovery.failed";

export const catalogedAgentSchema = z
    .object({
        agentVersion: z.string().min(1).max(128),
        id: IDENTIFIER,
        label: z.string().min(1).max(255),
    })
    .readonly();

export type CatalogedAgent = z.infer<typeof catalogedAgentSchema>;

const agentCatalogDiscoverCommandSchema = z
    .object({
        kind: z.literal(AGENT_CATALOG_DISCOVER_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentCatalogDiscoverCommand = z.infer<typeof agentCatalogDiscoverCommandSchema>;

const agentCatalogDiscoveredEventSchema = z
    .object({
        agents: z.array(catalogedAgentSchema).max(64).readonly(),
        kind: z.literal(AGENT_CATALOG_DISCOVERED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentCatalogDiscoveredEvent = z.infer<typeof agentCatalogDiscoveredEventSchema>;

const agentCatalogDiscoveryFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(AGENT_CATALOG_DISCOVERY_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentCatalogDiscoveryFailedEvent = z.infer<typeof agentCatalogDiscoveryFailedEventSchema>;

export const decodeAgentCatalogDiscoverCommand = (encoded: string): AgentCatalogDiscoverCommand =>
    decode(encoded, agentCatalogDiscoverCommandSchema);
export const encodeAgentCatalogDiscoverCommand = (message: AgentCatalogDiscoverCommand): string =>
    encode(message, agentCatalogDiscoverCommandSchema);
export const decodeAgentCatalogDiscoveredEvent = (encoded: string): AgentCatalogDiscoveredEvent =>
    decode(encoded, agentCatalogDiscoveredEventSchema);
export const encodeAgentCatalogDiscoveredEvent = (message: AgentCatalogDiscoveredEvent): string =>
    encode(message, agentCatalogDiscoveredEventSchema);
export const decodeAgentCatalogDiscoveryFailedEvent = (encoded: string): AgentCatalogDiscoveryFailedEvent =>
    decode(encoded, agentCatalogDiscoveryFailedEventSchema);
export const encodeAgentCatalogDiscoveryFailedEvent = (message: AgentCatalogDiscoveryFailedEvent): string =>
    encode(message, agentCatalogDiscoveryFailedEventSchema);
