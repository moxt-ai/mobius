import {
    MAX_LOCAL_AGENT_DIRECTORY_ENTRIES,
    type SessionCapabilities,
    sessionCapabilitiesSchema,
} from "@moxt-ai/mobius-protocol";
import type { HttpError } from "../http-error.ts";

export const PAIRING_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;
export const ACCESS_GRANT_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;
export const MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS = 60 * 1_000;
export const MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;
export const MAX_RUNTIMES_PER_PROJECT = 8;

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const SESSION_CAPABILITY_FIELDS: readonly string[] = [
    "additionalDirectories",
    "audioPrompt",
    "closeSession",
    "deleteSession",
    "embeddedContextPrompt",
    "imagePrompt",
    "listSessions",
    "loadSession",
    "promptQueueing",
    "resumeSession",
    "steering",
    "unstableForkSession",
];

export interface AgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly agentSettingsDiscovery?: boolean;
    readonly capabilities: SessionCapabilities;
    readonly id: string;
    readonly label: string;
    readonly sessionTurnConfiguration?: boolean;
}

export abstract class InstallableAgentDescriptor {
    readonly id: string;
    readonly label: string;
    abstract readonly status: string;

    protected constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }
}

export class MissingAgentDescriptor extends InstallableAgentDescriptor {
    readonly status = "agent_not_installed";

    public constructor(id: string, label: string) {
        super(id, label);
    }
}

export class AgentIntegrationDescriptor extends InstallableAgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly status = "integration_not_installed";

    constructor(id: string, label: string, agentPath: string, agentVersion: string) {
        super(id, label);
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
    }
}

export class CreatedRuntimePairing {
    readonly channelId: string;
    readonly expiresAt: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly pollToken: string;
    readonly projectId: string;
    readonly runtimeId: string;

    constructor(
        channelId: string,
        expiresAt: string,
        pairingCode: string,
        pairingId: string,
        pollToken: string,
        projectId: string,
        runtimeId: string,
    ) {
        this.channelId = channelId;
        this.expiresAt = expiresAt;
        this.pairingCode = pairingCode;
        this.pairingId = pairingId;
        this.pollToken = pollToken;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
    }
}

export interface ClaimedPairing {
    readonly appId: string;
    readonly channelId: string;
    readonly daemonToken: string;
    readonly runtimeId: string;
}

export interface CreatedChannelAccessGrant {
    readonly expiresAt: string;
    readonly grantId: string;
    readonly grantSecret: string;
}

export interface RedeemedChannelAccessGrant {
    readonly channelId: string;
    readonly hostToken: string;
    readonly projectId: string;
}

export class LinkedChannelDevice {
    readonly createdAt: string;
    readonly credentialId: string;
    readonly lastUsedAt: string;

    constructor(credentialId: string, createdAt: string, lastUsedAt: string) {
        this.createdAt = createdAt;
        this.credentialId = credentialId;
        this.lastUsedAt = lastUsedAt;
    }
}

export class VerifiedChannelAccess {
    readonly agents: readonly AgentDescriptor[];
    readonly channelId: string;
    readonly projectId: string;
    readonly runtimeId: string;

    constructor(channelId: string, runtimeId: string, projectId: string, agents: readonly AgentDescriptor[]) {
        this.agents = agents;
        this.channelId = channelId;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
    }
}

export class ChannelHostCredential extends VerifiedChannelAccess {
    readonly credentialId: string;

    constructor(channelId: string, runtimeId: string, projectId: string, credentialId: string) {
        super(channelId, runtimeId, projectId, []);
        this.credentialId = credentialId;
    }
}

export class ChannelDescriptor {
    readonly agents: readonly AgentDescriptor[];
    readonly channelId: string;
    readonly installableAgents: readonly InstallableAgentDescriptor[];
    readonly machineName: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly AgentDescriptor[],
        channelId: string,
        machineName: string,
        workspaceName: string,
        projectId: string,
        runtimeId: string,
        installableAgents: readonly InstallableAgentDescriptor[] = [],
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

export class CreatedBrowserCredential {
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly projectId: string;
    readonly token: string;

    constructor(credentialId: string, expiresAt: string, projectId: string, token: string) {
        this.credentialId = credentialId;
        this.expiresAt = expiresAt;
        this.projectId = projectId;
        this.token = token;
    }
}

export const PairingLifecycle = Object.freeze({
    Expired: "expired",
    Paired: "paired",
    Pending: "pending",
    Revoked: "revoked",
});

export abstract class PairingStatus {
    abstract readonly status: string;
}

export class PendingPairingStatus extends PairingStatus {
    readonly expiresAt: string;
    readonly status = PairingLifecycle.Pending;

    constructor(expiresAt: string) {
        super();
        this.expiresAt = expiresAt;
    }
}

export class ExpiredPairingStatus extends PairingStatus {
    readonly status = PairingLifecycle.Expired;
}

export class PairedPairingStatus extends PairingStatus {
    readonly agents: readonly AgentDescriptor[];
    readonly channelId: string;
    readonly installableAgents: readonly InstallableAgentDescriptor[];
    readonly machineName: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly status = PairingLifecycle.Paired;
    readonly workspaceName: string;

    constructor(
        agents: readonly AgentDescriptor[],
        channelId: string,
        machineName: string,
        workspaceName: string,
        projectId: string,
        runtimeId: string,
        installableAgents: readonly InstallableAgentDescriptor[] = [],
    ) {
        super();
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

export class RevokedPairingStatus extends PairingStatus {
    readonly revokedAt: string;
    readonly status = PairingLifecycle.Revoked;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export class PairingDirectoryError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingDirectoryError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: pairingDirectoryErrorStatus(this.code),
    });
}

function pairingDirectoryErrorStatus(code: string): number {
    switch (code) {
        case "pairing_not_found":
        case "runtime_not_found":
        case "channel_not_found":
        case "access_grant_invalid":
        case "linked_device_not_found":
        case "browser_credential_not_found":
            return 404;
        case "unauthorized":
        case "credential_expired":
        case "credential_revoked":
            return 401;
        case "owner_access_required":
        case "runtime_access_denied":
        case "workspace_required":
            return 403;
        case "access_grant_expired":
            return 410;
        case "access_grant_redeemed":
        case "runtime_unavailable":
        case "agent_settings_discovery_unsupported":
        case "session_turn_configuration_unsupported":
        case "idempotency_conflict":
            return 409;
        case "pairing_timeout":
        case "directory_timeout":
            return 504;
        case "runtime_quota_exceeded":
            return 429;
        case "directory_unavailable":
        case "runtime_disconnect_failed":
            return 503;
        default:
            return 400;
    }
}

export class RevokedProjectRuntime {
    readonly access: VerifiedChannelAccess;
    readonly revokedAt: string;

    constructor(access: VerifiedChannelAccess, revokedAt: string) {
        this.access = access;
        this.revokedAt = revokedAt;
    }
}

export function createRandomToken(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createRandomPairingCode(): string {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    let code = "";
    for (const byte of bytes) {
        code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
    }
    return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function normalizePairingCode(code: string): string {
    const normalized = code.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(normalized)) {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalized;
}

export async function hashSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseAgents(encoded: string): readonly AgentDescriptor[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new PairingDirectoryError("invalid_directory_record", "The paired agent directory is invalid", {
            cause: error,
        });
    }
    return validateAgents(normalizePersistedAgents(value));
}

export function parseInstallableAgents(encoded: string): readonly InstallableAgentDescriptor[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new PairingDirectoryError("invalid_directory_record", "The installable Agent directory is invalid", {
            cause: error,
        });
    }
    return validateInstallableAgents(normalizePersistedInstallableAgents(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedSessionCapabilities(): SessionCapabilities {
    return Object.freeze({
        additionalDirectories: false,
        audioPrompt: false,
        closeSession: false,
        deleteSession: false,
        embeddedContextPrompt: false,
        imagePrompt: false,
        listSessions: false,
        loadSession: false,
        promptQueueing: false,
        resumeSession: false,
        steering: false,
        unstableForkSession: false,
    });
}

function normalizePersistedAgents(value: unknown): unknown {
    if (!Array.isArray(value)) {
        return value;
    }
    return value.map((candidate) => {
        if (
            isRecord(candidate) &&
            Object.keys(candidate).length === 2 &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label")
        ) {
            return {
                agentPath: "Not reported",
                agentVersion: "Not reported",
                capabilities: unsupportedSessionCapabilities(),
                id: candidate["id"],
                label: candidate["label"],
            };
        }
        if (
            isRecord(candidate) &&
            Object.keys(candidate).length === 3 &&
            Object.hasOwn(candidate, "capabilities") &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label")
        ) {
            return {
                agentPath: "Not reported",
                agentVersion: "Not reported",
                capabilities: candidate["capabilities"],
                id: candidate["id"],
                label: candidate["label"],
            };
        }
        if (
            isRecord(candidate) &&
            Object.keys(candidate).length === 4 &&
            Object.hasOwn(candidate, "agentPath") &&
            Object.hasOwn(candidate, "agentVersion") &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label")
        ) {
            return {
                agentPath: candidate["agentPath"],
                agentVersion: candidate["agentVersion"],
                capabilities: unsupportedSessionCapabilities(),
                id: candidate["id"],
                label: candidate["label"],
            };
        }
        return candidate;
    });
}

function validateAgentCapabilities(value: unknown): SessionCapabilities {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== SESSION_CAPABILITY_FIELDS.length ||
        SESSION_CAPABILITY_FIELDS.some((field) => !Object.hasOwn(value, field))
    ) {
        throw new PairingDirectoryError("invalid_agents", "The local Agent capabilities are invalid");
    }
    const parsed = sessionCapabilitiesSchema.safeParse(value);
    if (!parsed.success) {
        throw new PairingDirectoryError("invalid_agents", "The local Agent capabilities are invalid", {
            cause: parsed.error,
        });
    }
    return parsed.data;
}

function normalizePersistedInstallableAgents(value: unknown): unknown {
    if (!Array.isArray(value)) {
        return value;
    }
    return value.map((candidate) => {
        if (
            isRecord(candidate) &&
            Object.keys(candidate).length === 2 &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label")
        ) {
            return {
                id: candidate["id"],
                label: candidate["label"],
                status: "agent_not_installed",
            };
        }
        return candidate;
    });
}

export function validateAgents(value: unknown): readonly AgentDescriptor[] {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingDirectoryError("invalid_agents", "The ready Agent directory is invalid");
    }

    const agents: AgentDescriptor[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            Object.keys(candidate).length < 5 ||
            Object.keys(candidate).length > 7 ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "capabilities") ||
            !Object.hasOwn(candidate, "id") ||
            !Object.hasOwn(candidate, "label") ||
            Object.keys(candidate).some(
                (key) =>
                    key !== "agentPath" &&
                    key !== "agentVersion" &&
                    key !== "agentSettingsDiscovery" &&
                    key !== "capabilities" &&
                    key !== "id" &&
                    key !== "label" &&
                    key !== "sessionTurnConfiguration",
            ) ||
            (Object.hasOwn(candidate, "agentSettingsDiscovery") &&
                typeof candidate["agentSettingsDiscovery"] !== "boolean") ||
            (Object.hasOwn(candidate, "sessionTurnConfiguration") &&
                typeof candidate["sessionTurnConfiguration"] !== "boolean")
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        const capabilities = validateAgentCapabilities(candidate["capabilities"]);
        const id = candidate["id"];
        const label = candidate["label"];
        const agentPath = candidate["agentPath"];
        const agentVersion = candidate["agentVersion"];
        const agentSettingsDiscovery = candidate["agentSettingsDiscovery"];
        const sessionTurnConfiguration = candidate["sessionTurnConfiguration"];
        if (
            typeof agentPath !== "string" ||
            agentPath.trim().length === 0 ||
            agentPath.length > 4_096 ||
            typeof agentVersion !== "string" ||
            agentVersion.trim().length === 0 ||
            agentVersion.length > 128 ||
            typeof id !== "string" ||
            !IDENTIFIER_PATTERN.test(id) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80 ||
            identifiers.has(id)
        ) {
            throw new PairingDirectoryError("invalid_agents", "The local agent directory is invalid");
        }
        identifiers.add(id);
        agents.push({
            agentPath,
            agentVersion: agentVersion.trim(),
            ...(agentSettingsDiscovery === true ? { agentSettingsDiscovery } : {}),
            capabilities,
            id,
            label: label.trim(),
            ...(sessionTurnConfiguration === true ? { sessionTurnConfiguration } : {}),
        });
    }
    return agents;
}

export function validateInstallableAgents(value: unknown): readonly InstallableAgentDescriptor[] {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingDirectoryError("invalid_agents", "The installable Agent directory is invalid");
    }
    const agents: InstallableAgentDescriptor[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            throw new PairingDirectoryError("invalid_agents", "The installable Agent directory is invalid");
        }
        const id = candidate["id"];
        const label = candidate["label"];
        if (
            typeof id !== "string" ||
            !IDENTIFIER_PATTERN.test(id) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80 ||
            identifiers.has(id)
        ) {
            throw new PairingDirectoryError("invalid_agents", "The installable Agent directory is invalid");
        }
        identifiers.add(id);
        const status = candidate["status"];
        if (
            status === "agent_not_installed" &&
            Object.keys(candidate).length === 3 &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            agents.push(new MissingAgentDescriptor(id, label.trim()));
            continue;
        }
        if (
            status === "integration_not_installed" &&
            Object.keys(candidate).length === 5 &&
            Object.hasOwn(candidate, "agentPath") &&
            Object.hasOwn(candidate, "agentVersion") &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            const agentPath = candidate["agentPath"];
            const agentVersion = candidate["agentVersion"];
            if (
                typeof agentPath !== "string" ||
                agentPath.trim().length === 0 ||
                agentPath.length > 4_096 ||
                typeof agentVersion !== "string" ||
                agentVersion.trim().length === 0 ||
                agentVersion.length > 128
            ) {
                throw new PairingDirectoryError("invalid_agents", "The installable Agent directory is invalid");
            }
            agents.push(new AgentIntegrationDescriptor(id, label.trim(), agentPath, agentVersion.trim()));
            continue;
        }
        throw new PairingDirectoryError("invalid_agents", "The installable Agent directory is invalid");
    }
    return agents;
}

export function validateAgentCatalog(
    agents: readonly AgentDescriptor[],
    installableAgents: readonly InstallableAgentDescriptor[],
): void {
    const directorySize = agents.length + installableAgents.length;
    if (directorySize === 0) {
        throw new PairingDirectoryError("invalid_agents", "At least one ready or installable local Agent is required");
    }
    if (directorySize > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingDirectoryError("invalid_agents", "The local Agent directory exceeds its maximum size");
    }
    const readyIds = new Set(agents.map((agent) => agent.id));
    if (installableAgents.some((agent) => readyIds.has(agent.id))) {
        throw new PairingDirectoryError("invalid_agents", "An Agent cannot be both ready and installable");
    }
}

export function validateDisplayName(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return normalized;
}

export function validatePairingCode(value: unknown): string {
    if (typeof value !== "string") {
        throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
    }
    return normalizePairingCode(value);
}

export function validateIdentifier(value: string, field: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new PairingDirectoryError(`invalid_${field}`, `The ${field.replaceAll("_", " ")} is invalid`);
    }
    return value;
}

export function validateToken(value: string): string {
    if (!TOKEN_PATTERN.test(value)) {
        throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
    }
    return value;
}
