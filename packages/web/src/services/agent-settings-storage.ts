import { type AgentSettingsDiscoveredEvent, decodeAgentSettingsDiscoveredEvent } from "@moxt-ai/mobius-sdk";

const AGENT_SETTINGS_PREFIX = "mobius:agent-settings:";
const MAXIMUM_STORED_CHARACTERS = 512 * 1024;

function storageKey(channelId: string, agentId: string): string {
    return `${AGENT_SETTINGS_PREFIX}${encodeURIComponent(channelId)}:${encodeURIComponent(agentId)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the Agent settings that a previous browser session discovered.
 *
 * Stored settings are untrusted input. The record is decoded as `unknown`,
 * validated against the protocol schema, and accepted only when it still
 * describes the requested Agent at the Agent version the Runtime reports now.
 */
export function readStoredAgentSettings(
    channelId: string,
    agentId: string,
    agentVersion: string,
): AgentSettingsDiscoveredEvent | undefined {
    try {
        const stored = window.localStorage.getItem(storageKey(channelId, agentId));
        if (agentVersion.length === 0 || stored === null || stored.length > MAXIMUM_STORED_CHARACTERS) {
            return undefined;
        }
        const decoded: unknown = JSON.parse(stored);
        if (!isRecord(decoded) || typeof decoded["event"] !== "string" || decoded["agentVersion"] !== agentVersion) {
            return undefined;
        }
        const event = decodeAgentSettingsDiscoveredEvent(decoded["event"]);
        return event.agentId === agentId ? event : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Persists discovered Agent settings so the next browser session can render run
 * settings without waiting for the Runtime to rediscover them.
 */
export function saveStoredAgentSettings(
    channelId: string,
    agentId: string,
    agentVersion: string,
    event: AgentSettingsDiscoveredEvent,
): void {
    if (event.agentId !== agentId || agentVersion.length === 0) {
        return;
    }
    try {
        const record = JSON.stringify({ agentVersion, event: JSON.stringify(event) });
        if (record.length > MAXIMUM_STORED_CHARACTERS) {
            return;
        }
        window.localStorage.setItem(storageKey(channelId, agentId), record);
    } catch {}
}
