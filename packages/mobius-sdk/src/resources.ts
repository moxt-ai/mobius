import { type SessionCapabilities, sessionCapabilitiesSchema } from "@moxt-ai/mobius-protocol";

import { MobiusProtocolError, MobiusValidationError } from "./errors.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
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

function invalidResponse(message: string): MobiusProtocolError {
    return new MobiusProtocolError(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw invalidResponse(`The service returned an invalid ${name}`);
    }
    return value;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string, maximumLength = 8_500_000): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximumLength) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function identifierField(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = stringField(value, field, 128);
    if (!IDENTIFIER_PATTERN.test(candidate)) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function _integerField(value: Readonly<Record<string, unknown>>, field: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function booleanField(value: Readonly<Record<string, unknown>>, field: string): boolean {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function arrayField(
    value: Readonly<Record<string, unknown>>,
    field: string,
    maximumLength = 10_000,
): readonly unknown[] {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.length > maximumLength) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return candidate;
}

function validateTimestamp(value: string, field: string): string {
    if (Number.isNaN(Date.parse(value))) {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
    return value;
}

export class MobiusBrowserCredentialRequest {
    readonly expiresInSeconds: number;

    constructor(expiresInSeconds: number) {
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3_600) {
            throw new MobiusValidationError("The browser credential lifetime is invalid");
        }
        this.expiresInSeconds = expiresInSeconds;
    }
}

export class MobiusRuntimePairingRequest {
    readonly idempotencyKey: string;

    constructor(idempotencyKey: string) {
        if (!IDENTIFIER_PATTERN.test(idempotencyKey)) {
            throw new MobiusValidationError("The Runtime pairing idempotency key is invalid");
        }
        this.idempotencyKey = idempotencyKey;
    }
}

export class MobiusBrowserCredential {
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

export function decodeMobiusBrowserCredential(value: unknown): MobiusBrowserCredential {
    const credential = record(value, "browser credential");
    return new MobiusBrowserCredential(
        identifierField(credential, "credentialId"),
        validateTimestamp(stringField(credential, "expiresAt", 128), "expiresAt"),
        identifierField(credential, "projectId"),
        stringField(credential, "token", 256),
    );
}

export class MobiusAgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly agentSettingsDiscovery?: boolean;
    readonly capabilities: SessionCapabilities;
    readonly id: string;
    readonly label: string;
    readonly sessionTurnConfiguration?: boolean;

    constructor(
        agentPath: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        id: string,
        label: string,
        agentSettingsDiscovery?: boolean,
        sessionTurnConfiguration?: boolean,
    ) {
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
        if (agentSettingsDiscovery === true) {
            this.agentSettingsDiscovery = true;
        }
        this.capabilities = Object.freeze({ ...capabilities });
        this.id = id;
        this.label = label;
        if (sessionTurnConfiguration === true) {
            this.sessionTurnConfiguration = true;
        }
    }
}

export function decodeMobiusAgentCapabilities(value: unknown): SessionCapabilities {
    const capabilities = record(value, "Agent capabilities");
    if (
        Object.keys(capabilities).length !== SESSION_CAPABILITY_FIELDS.length ||
        SESSION_CAPABILITY_FIELDS.some((field) => !Object.hasOwn(capabilities, field))
    ) {
        throw invalidResponse("The service returned invalid Agent capabilities");
    }
    const parsed = sessionCapabilitiesSchema.safeParse(capabilities);
    if (!parsed.success) {
        throw invalidResponse("The service returned invalid Agent capabilities");
    }
    return parsed.data;
}

function decodeAgentDescriptor(value: unknown): MobiusAgentDescriptor {
    const agent = record(value, "Agent descriptor");
    if (
        Object.keys(agent).length < 5 ||
        Object.keys(agent).length > 7 ||
        !Object.hasOwn(agent, "agentPath") ||
        !Object.hasOwn(agent, "agentVersion") ||
        !Object.hasOwn(agent, "capabilities") ||
        !Object.hasOwn(agent, "id") ||
        !Object.hasOwn(agent, "label") ||
        Object.keys(agent).some(
            (key) =>
                key !== "agentPath" &&
                key !== "agentVersion" &&
                key !== "agentSettingsDiscovery" &&
                key !== "capabilities" &&
                key !== "id" &&
                key !== "label" &&
                key !== "sessionTurnConfiguration",
        ) ||
        (Object.hasOwn(agent, "agentSettingsDiscovery") && typeof agent["agentSettingsDiscovery"] !== "boolean") ||
        (Object.hasOwn(agent, "sessionTurnConfiguration") && typeof agent["sessionTurnConfiguration"] !== "boolean")
    ) {
        throw invalidResponse("The service returned an invalid Agent descriptor");
    }
    const agentPath = stringField(agent, "agentPath", 4_096);
    const agentVersion = stringField(agent, "agentVersion", 128);
    const label = stringField(agent, "label", 80);
    if (agentPath.trim().length === 0 || agentVersion.trim().length === 0 || label.trim().length === 0) {
        throw invalidResponse("The service returned an invalid Agent descriptor");
    }
    return new MobiusAgentDescriptor(
        agentPath,
        agentVersion,
        decodeMobiusAgentCapabilities(agent["capabilities"]),
        identifierField(agent, "id"),
        label.trim(),
        agent["agentSettingsDiscovery"] === true,
        agent["sessionTurnConfiguration"] === true,
    );
}

export abstract class MobiusInstallableAgentDescriptor {
    readonly id: string;
    readonly label: string;
    abstract readonly status: string;

    protected constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }
}

export class MobiusMissingAgentDescriptor extends MobiusInstallableAgentDescriptor {
    readonly status = "agent_not_installed";

    constructor(id: string, label: string) {
        super(id, label);
    }
}

export class MobiusAgentIntegrationDescriptor extends MobiusInstallableAgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly status = "integration_not_installed";

    constructor(agentPath: string, agentVersion: string, id: string, label: string) {
        super(id, label);
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
    }
}

function decodeInstallableAgentDescriptor(value: unknown): MobiusInstallableAgentDescriptor {
    const agent = record(value, "installable Agent descriptor");
    const id = identifierField(agent, "id");
    const label = stringField(agent, "label", 80);
    if (label.trim().length === 0) {
        throw invalidResponse("The service returned an invalid installable Agent descriptor");
    }
    if (
        agent["status"] === "agent_not_installed" &&
        Object.keys(agent).length === 3 &&
        Object.hasOwn(agent, "id") &&
        Object.hasOwn(agent, "label") &&
        Object.hasOwn(agent, "status")
    ) {
        return new MobiusMissingAgentDescriptor(id, label.trim());
    }
    if (
        agent["status"] === "integration_not_installed" &&
        Object.keys(agent).length === 5 &&
        Object.hasOwn(agent, "agentPath") &&
        Object.hasOwn(agent, "agentVersion") &&
        Object.hasOwn(agent, "id") &&
        Object.hasOwn(agent, "label") &&
        Object.hasOwn(agent, "status")
    ) {
        const agentPath = stringField(agent, "agentPath", 4_096);
        const agentVersion = stringField(agent, "agentVersion", 128);
        if (agentPath.trim().length === 0 || agentVersion.trim().length === 0) {
            throw invalidResponse("The service returned an invalid installable Agent descriptor");
        }
        return new MobiusAgentIntegrationDescriptor(agentPath, agentVersion.trim(), id, label.trim());
    }
    throw invalidResponse("The service returned an invalid installable Agent descriptor");
}

export class MobiusRuntimeDescriptor {
    readonly agents: readonly MobiusAgentDescriptor[];
    readonly channelId: string;
    readonly installableAgents: readonly MobiusInstallableAgentDescriptor[];
    readonly machineName: string;
    readonly online: boolean;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        installableAgents: readonly MobiusInstallableAgentDescriptor[],
        machineName: string,
        online: boolean,
        projectId: string,
        runtimeId: string,
        workspaceName: string,
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.online = online;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

function decodeRuntimeDescriptor(value: unknown): MobiusRuntimeDescriptor {
    const runtime = record(value, "Runtime descriptor");
    return new MobiusRuntimeDescriptor(
        arrayField(runtime, "agents", 100).map(decodeAgentDescriptor),
        identifierField(runtime, "channelId"),
        arrayField(runtime, "installableAgents", 100).map(decodeInstallableAgentDescriptor),
        stringField(runtime, "machineName", 255),
        booleanField(runtime, "online"),
        identifierField(runtime, "projectId"),
        identifierField(runtime, "runtimeId"),
        stringField(runtime, "workspaceName", 255),
    );
}

export function decodeMobiusRuntimeList(value: unknown): readonly MobiusRuntimeDescriptor[] {
    const response = record(value, "Runtime list");
    return arrayField(response, "runtimes", 100).map(decodeRuntimeDescriptor);
}

export class MobiusRuntimePairing {
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

export class MobiusRuntimePairingWaitOptions {
    readonly pollIntervalMilliseconds: number;
    readonly timeoutMilliseconds: number;

    constructor(timeoutMilliseconds = 120_000, pollIntervalMilliseconds = 1_000) {
        if (
            !Number.isSafeInteger(timeoutMilliseconds) ||
            timeoutMilliseconds < 1 ||
            timeoutMilliseconds > 30 * 60 * 1_000 ||
            !Number.isSafeInteger(pollIntervalMilliseconds) ||
            pollIntervalMilliseconds < 1 ||
            pollIntervalMilliseconds > timeoutMilliseconds
        ) {
            throw new MobiusValidationError("The Runtime pairing wait bounds are invalid");
        }
        this.pollIntervalMilliseconds = pollIntervalMilliseconds;
        this.timeoutMilliseconds = timeoutMilliseconds;
    }
}

export function decodeMobiusRuntimePairing(value: unknown): MobiusRuntimePairing {
    const pairing = record(value, "Runtime pairing");
    const pairingCode = stringField(pairing, "pairingCode", 24);
    const pollToken = stringField(pairing, "pollToken", 256);
    if (
        !/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/.test(pairingCode) ||
        !/^[a-zA-Z0-9_-]{32,256}$/.test(pollToken)
    ) {
        throw invalidResponse("The service returned invalid Runtime pairing credentials");
    }
    return new MobiusRuntimePairing(
        identifierField(pairing, "channelId"),
        validateTimestamp(stringField(pairing, "expiresAt", 128), "expiresAt"),
        pairingCode,
        identifierField(pairing, "pairingId"),
        pollToken,
        identifierField(pairing, "projectId"),
        identifierField(pairing, "runtimeId"),
    );
}

export const MobiusRuntimePairingLifecycle = Object.freeze({
    Expired: "expired",
    Paired: "paired",
    Pending: "pending",
    Revoked: "revoked",
});

export abstract class MobiusRuntimePairingStatus {
    abstract readonly status: string;
}

export class MobiusPendingRuntimePairingStatus extends MobiusRuntimePairingStatus {
    readonly expiresAt: string;
    readonly status = MobiusRuntimePairingLifecycle.Pending;

    constructor(expiresAt: string) {
        super();
        this.expiresAt = expiresAt;
    }
}

export class MobiusExpiredRuntimePairingStatus extends MobiusRuntimePairingStatus {
    readonly status = MobiusRuntimePairingLifecycle.Expired;
}

export class MobiusPairedRuntimePairingStatus extends MobiusRuntimePairingStatus {
    readonly agents: readonly MobiusAgentDescriptor[];
    readonly channelId: string;
    readonly installableAgents: readonly MobiusInstallableAgentDescriptor[];
    readonly machineName: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly status = MobiusRuntimePairingLifecycle.Paired;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        installableAgents: readonly MobiusInstallableAgentDescriptor[],
        machineName: string,
        projectId: string,
        runtimeId: string,
        workspaceName: string,
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

export class MobiusRevokedRuntimePairingStatus extends MobiusRuntimePairingStatus {
    readonly revokedAt: string;
    readonly status = MobiusRuntimePairingLifecycle.Revoked;

    constructor(revokedAt: string) {
        super();
        this.revokedAt = revokedAt;
    }
}

export function decodeMobiusRuntimePairingStatus(value: unknown): MobiusRuntimePairingStatus {
    const status = record(value, "Runtime pairing status");
    const lifecycle = stringField(status, "status", 32);
    if (lifecycle === MobiusRuntimePairingLifecycle.Pending) {
        return new MobiusPendingRuntimePairingStatus(
            validateTimestamp(stringField(status, "expiresAt", 128), "expiresAt"),
        );
    }
    if (lifecycle === MobiusRuntimePairingLifecycle.Expired) {
        return new MobiusExpiredRuntimePairingStatus();
    }
    if (lifecycle === MobiusRuntimePairingLifecycle.Revoked) {
        return new MobiusRevokedRuntimePairingStatus(
            validateTimestamp(stringField(status, "revokedAt", 128), "revokedAt"),
        );
    }
    if (lifecycle === MobiusRuntimePairingLifecycle.Paired) {
        return new MobiusPairedRuntimePairingStatus(
            arrayField(status, "agents", 100).map(decodeAgentDescriptor),
            identifierField(status, "channelId"),
            arrayField(status, "installableAgents", 100).map(decodeInstallableAgentDescriptor),
            stringField(status, "machineName", 255),
            identifierField(status, "projectId"),
            identifierField(status, "runtimeId"),
            stringField(status, "workspaceName", 255),
        );
    }
    throw invalidResponse("The service returned an unsupported Runtime pairing status");
}
