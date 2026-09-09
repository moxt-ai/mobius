import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type Attempt,
    decodeAttempt,
    decodeCommittedSessionEvent,
    decodeInteraction,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeRecordedSessionEvent,
    decodeTurn,
    type Interaction,
    MOBIUS_API_VERSION,
    MOBIUS_EVENT_FORMAT_VERSION,
    MOBIUS_SESSION_EVENT_STREAM_EVENT,
    MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE,
    MOBIUS_SESSION_EVENT_STREAM_TRANSPORT,
    MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
    type PromptImage,
    type PromptResource,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    SESSION_STARTED_KIND,
    type SessionCapabilities,
    sessionCapabilitiesSchema,
} from "@moxt-ai/mobius-protocol";

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
    "resumeSession",
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

function integerField(value: Readonly<Record<string, unknown>>, field: string): number {
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

function nullableCursor(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = value[field];
    if (candidate === null) {
        return "";
    }
    if (typeof candidate !== "string" || candidate.length > 512) {
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

export class MobiusSessionEventCapabilities {
    readonly eventName: string;
    readonly formatVersion: string;
    readonly mediaType: string;
    readonly transport: string;

    constructor(eventName: string, formatVersion: string, mediaType: string, transport: string) {
        this.eventName = eventName;
        this.formatVersion = formatVersion;
        this.mediaType = mediaType;
        this.transport = transport;
    }
}

export class MobiusArtifactCapabilities {
    readonly downloadTransport: string;
    readonly uploadProtocol: string;

    constructor(downloadTransport: string, uploadProtocol: string) {
        this.downloadTransport = downloadTransport;
        this.uploadProtocol = uploadProtocol;
    }
}

export class MobiusAuthenticationCapabilities {
    readonly browserCredentials: boolean;
    readonly maximumBrowserCredentialLifetimeSeconds: number;
    readonly minimumBrowserCredentialLifetimeSeconds: number;

    constructor(
        browserCredentials: boolean,
        maximumBrowserCredentialLifetimeSeconds: number,
        minimumBrowserCredentialLifetimeSeconds: number,
    ) {
        this.browserCredentials = browserCredentials;
        this.maximumBrowserCredentialLifetimeSeconds = maximumBrowserCredentialLifetimeSeconds;
        this.minimumBrowserCredentialLifetimeSeconds = minimumBrowserCredentialLifetimeSeconds;
    }
}

export class MobiusPortabilityCapabilities {
    readonly exportFormatVersion: string;
    readonly nativeContextImport: boolean;
    readonly targetBindingRequired: boolean;

    constructor(exportFormatVersion: string, nativeContextImport: boolean, targetBindingRequired: boolean) {
        this.exportFormatVersion = exportFormatVersion;
        this.nativeContextImport = nativeContextImport;
        this.targetBindingRequired = targetBindingRequired;
    }
}

export class MobiusResourceCapabilities {
    readonly artifacts: boolean;
    readonly attempts: boolean;
    readonly browserCredentials: boolean;
    readonly events: boolean;
    readonly interactions: boolean;
    readonly messages: boolean;
    readonly portability: boolean;
    readonly runtimePairings: boolean;
    readonly runtimes: boolean;
    readonly sessions: boolean;
    readonly toolCalls: boolean;
    readonly turns: boolean;

    constructor(resources: Readonly<Record<string, unknown>>) {
        this.artifacts = booleanField(resources, "artifacts");
        this.attempts = booleanField(resources, "attempts");
        this.browserCredentials = booleanField(resources, "browserCredentials");
        this.events = booleanField(resources, "events");
        this.interactions = booleanField(resources, "interactions");
        this.messages = booleanField(resources, "messages");
        this.portability = booleanField(resources, "portability");
        this.runtimePairings = booleanField(resources, "runtimePairings");
        this.runtimes = booleanField(resources, "runtimes");
        this.sessions = booleanField(resources, "sessions");
        this.toolCalls = booleanField(resources, "toolCalls");
        this.turns = booleanField(resources, "turns");
    }
}

export class MobiusServiceCapabilities {
    readonly apiVersion: string;
    readonly artifacts: MobiusArtifactCapabilities;
    readonly authentication: MobiusAuthenticationCapabilities;
    readonly portability: MobiusPortabilityCapabilities;
    readonly resources: MobiusResourceCapabilities;
    readonly sessionEvents: MobiusSessionEventCapabilities;

    constructor(
        apiVersion: string,
        artifacts: MobiusArtifactCapabilities,
        authentication: MobiusAuthenticationCapabilities,
        portability: MobiusPortabilityCapabilities,
        resources: MobiusResourceCapabilities,
        sessionEvents: MobiusSessionEventCapabilities,
    ) {
        this.apiVersion = apiVersion;
        this.artifacts = artifacts;
        this.authentication = authentication;
        this.portability = portability;
        this.resources = resources;
        this.sessionEvents = sessionEvents;
    }
}

export function decodeMobiusServiceCapabilities(value: unknown): MobiusServiceCapabilities {
    const capabilities = record(value, "service capabilities");
    const resources = record(capabilities["resources"], "resource capabilities");
    const artifacts = record(capabilities["artifacts"], "artifact capabilities");
    const authentication = record(capabilities["authentication"], "authentication capabilities");
    const portability = record(capabilities["portability"], "portability capabilities");
    const sessionEvents = record(capabilities["sessionEvents"], "Session event capabilities");
    const apiVersion = stringField(capabilities, "apiVersion", 32);
    const eventName = stringField(sessionEvents, "eventName", 128);
    const formatVersion = stringField(sessionEvents, "formatVersion", 32);
    const mediaType = stringField(sessionEvents, "mediaType", 128);
    const transport = stringField(sessionEvents, "transport", 32);
    const downloadTransport = stringField(artifacts, "downloadTransport", 32);
    const uploadProtocol = stringField(artifacts, "uploadProtocol", 32);
    const exportFormatVersion = stringField(portability, "exportFormatVersion", 32);
    if (
        apiVersion !== MOBIUS_API_VERSION ||
        eventName !== MOBIUS_SESSION_EVENT_STREAM_EVENT ||
        formatVersion !== MOBIUS_EVENT_FORMAT_VERSION ||
        mediaType !== MOBIUS_SESSION_EVENT_STREAM_MEDIA_TYPE ||
        transport !== MOBIUS_SESSION_EVENT_STREAM_TRANSPORT ||
        downloadTransport !== "authorized-stream" ||
        uploadProtocol !== "two-stage" ||
        exportFormatVersion !== MOBIUS_SESSION_EXPORT_FORMAT_VERSION
    ) {
        throw invalidResponse("The service returned unsupported Mobius API capabilities");
    }
    return new MobiusServiceCapabilities(
        apiVersion,
        new MobiusArtifactCapabilities(downloadTransport, uploadProtocol),
        new MobiusAuthenticationCapabilities(
            booleanField(authentication, "browserCredentials"),
            integerField(authentication, "maximumBrowserCredentialLifetimeSeconds"),
            integerField(authentication, "minimumBrowserCredentialLifetimeSeconds"),
        ),
        new MobiusPortabilityCapabilities(
            exportFormatVersion,
            booleanField(portability, "nativeContextImport"),
            booleanField(portability, "targetBindingRequired"),
        ),
        new MobiusResourceCapabilities(resources),
        new MobiusSessionEventCapabilities(eventName, formatVersion, mediaType, transport),
    );
}

export class MobiusRecordingPolicy {
    readonly contentLimitBytes: number;
    readonly hotEventLimit: number;
    readonly idempotencyRetentionMilliseconds: number;
    readonly level: string;
    readonly retentionMilliseconds: number;

    constructor(
        level: string,
        retentionMilliseconds: number,
        hotEventLimit: number,
        contentLimitBytes: number,
        idempotencyRetentionMilliseconds = retentionMilliseconds,
    ) {
        if (
            (level !== "full" && level !== "summary") ||
            !Number.isSafeInteger(retentionMilliseconds) ||
            retentionMilliseconds < 60_000 ||
            !Number.isSafeInteger(hotEventLimit) ||
            hotEventLimit < 10 ||
            !Number.isSafeInteger(contentLimitBytes) ||
            contentLimitBytes < 1_024 ||
            !Number.isSafeInteger(idempotencyRetentionMilliseconds) ||
            idempotencyRetentionMilliseconds < 60_000 ||
            idempotencyRetentionMilliseconds > retentionMilliseconds
        ) {
            throw new MobiusValidationError("The Session recording policy is invalid");
        }
        this.contentLimitBytes = contentLimitBytes;
        this.hotEventLimit = hotEventLimit;
        this.idempotencyRetentionMilliseconds = idempotencyRetentionMilliseconds;
        this.level = level;
        this.retentionMilliseconds = retentionMilliseconds;
    }

    readonly toJSON = (): MobiusRecordingPolicyRequestPayload =>
        new MobiusRecordingPolicyRequestPayload(
            this.level,
            this.retentionMilliseconds,
            this.hotEventLimit,
            this.contentLimitBytes,
            this.idempotencyRetentionMilliseconds,
        );
}

class MobiusRecordingPolicyRequestPayload {
    readonly contentLimitBytes: number;
    readonly hotEventLimit: number;
    readonly idempotencyRetentionMilliseconds: number;
    readonly level: string;
    readonly retentionMilliseconds: number;

    constructor(
        level: string,
        retentionMilliseconds: number,
        hotEventLimit: number,
        contentLimitBytes: number,
        idempotencyRetentionMilliseconds: number,
    ) {
        this.contentLimitBytes = contentLimitBytes;
        this.hotEventLimit = hotEventLimit;
        this.idempotencyRetentionMilliseconds = idempotencyRetentionMilliseconds;
        this.level = level;
        this.retentionMilliseconds = retentionMilliseconds;
    }
}

export interface CreateMobiusSessionRequest {
    readonly agentId: string;
    readonly bindingId: string;
    readonly directoryId: string;
    readonly policy: MobiusRecordingPolicy;
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly title: string;
}

export interface ConfigureMobiusSessionRequest {
    readonly agentRef: string;
    readonly bindingId: string;
    readonly configRevision: number;
    readonly runtimeId: string;
    readonly workspaceRef: string;
}

export class MobiusSessionImportBinding {
    readonly agentRef: string;
    readonly bindingId: string;
    readonly configRevision: number;
    readonly runtimeId: string;
    readonly workspaceRef: string;

    constructor(bindingId: string, runtimeId: string, agentRef: string, workspaceRef: string, configRevision = 1) {
        this.agentRef = agentRef;
        this.bindingId = bindingId;
        this.configRevision = configRevision;
        this.runtimeId = runtimeId;
        this.workspaceRef = workspaceRef;
    }
}

export interface SubmitMobiusTurnRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
}

export interface CancelMobiusTurnRequest {
    readonly idempotencyKey: string;
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

export class MobiusArtifactUploadRequest {
    readonly byteLength: number;
    readonly mediaType: string;
    readonly name: string;
    readonly sha256: string;

    constructor(name: string, mediaType: string, byteLength: number, sha256: string) {
        if (
            name.length < 1 ||
            name.length > 500 ||
            name.includes("\0") ||
            mediaType.length < 1 ||
            mediaType.length > 255 ||
            mediaType.includes("\r") ||
            mediaType.includes("\n") ||
            !Number.isSafeInteger(byteLength) ||
            byteLength < 1 ||
            !/^[a-f0-9]{64}$/.test(sha256)
        ) {
            throw new MobiusValidationError("The artifact upload request is invalid");
        }
        this.byteLength = byteLength;
        this.mediaType = mediaType;
        this.name = name;
        this.sha256 = sha256;
    }
}

export abstract class MobiusArtifact {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly createdAt: string;
    readonly mediaType: string;
    readonly name: string;
    readonly sessionId: string;
    readonly sha256: string;
    abstract readonly state: string;

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
    ) {
        this.artifactId = artifactId;
        this.byteLength = byteLength;
        this.createdAt = createdAt;
        this.mediaType = mediaType;
        this.name = name;
        this.sessionId = sessionId;
        this.sha256 = sha256;
    }
}

export class MobiusUploadingArtifact extends MobiusArtifact {
    readonly expiresAt: string;
    readonly state = "uploading";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        expiresAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.expiresAt = expiresAt;
    }
}

export class MobiusArtifactUpload extends MobiusUploadingArtifact {
    readonly uploadToken: string;

    constructor(artifact: MobiusUploadingArtifact, uploadToken: string) {
        super(
            artifact.sessionId,
            artifact.artifactId,
            artifact.name,
            artifact.mediaType,
            artifact.byteLength,
            artifact.sha256,
            artifact.createdAt,
            artifact.expiresAt,
        );
        this.uploadToken = uploadToken;
    }
}

export class MobiusAvailableArtifact extends MobiusArtifact {
    readonly availableAt: string;
    readonly state = "available";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        availableAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.availableAt = availableAt;
    }
}

export class MobiusExpiredArtifact extends MobiusArtifact {
    readonly expiredAt: string;
    readonly state = "expired";

    constructor(
        sessionId: string,
        artifactId: string,
        name: string,
        mediaType: string,
        byteLength: number,
        sha256: string,
        createdAt: string,
        expiredAt: string,
    ) {
        super(sessionId, artifactId, name, mediaType, byteLength, sha256, createdAt);
        this.expiredAt = expiredAt;
    }
}

function artifactFields(value: Readonly<Record<string, unknown>>): {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly createdAt: string;
    readonly mediaType: string;
    readonly name: string;
    readonly sessionId: string;
    readonly sha256: string;
} {
    const sha256 = stringField(value, "sha256", 64);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw invalidResponse("The service returned an invalid artifact digest");
    }
    return {
        artifactId: identifierField(value, "artifactId"),
        byteLength: integerField(value, "byteLength"),
        createdAt: validateTimestamp(stringField(value, "createdAt", 128), "createdAt"),
        mediaType: stringField(value, "mediaType", 255),
        name: stringField(value, "name", 500),
        sessionId: identifierField(value, "sessionId"),
        sha256,
    };
}

function uploadingArtifact(value: Readonly<Record<string, unknown>>): MobiusUploadingArtifact {
    const fields = artifactFields(value);
    return new MobiusUploadingArtifact(
        fields.sessionId,
        fields.artifactId,
        fields.name,
        fields.mediaType,
        fields.byteLength,
        fields.sha256,
        fields.createdAt,
        validateTimestamp(stringField(value, "expiresAt", 128), "expiresAt"),
    );
}

export function decodeMobiusArtifactUpload(value: unknown): MobiusArtifactUpload {
    const artifact = record(value, "artifact upload authorization");
    return new MobiusArtifactUpload(uploadingArtifact(artifact), stringField(artifact, "uploadToken", 256));
}

export function decodeMobiusArtifact(value: unknown): MobiusArtifact {
    const artifact = record(value, "artifact");
    const state = stringField(artifact, "state", 32);
    if (state === "uploading") {
        return uploadingArtifact(artifact);
    }
    const fields = artifactFields(artifact);
    if (state === "available") {
        return new MobiusAvailableArtifact(
            fields.sessionId,
            fields.artifactId,
            fields.name,
            fields.mediaType,
            fields.byteLength,
            fields.sha256,
            fields.createdAt,
            validateTimestamp(stringField(artifact, "availableAt", 128), "availableAt"),
        );
    }
    if (state === "expired") {
        return new MobiusExpiredArtifact(
            fields.sessionId,
            fields.artifactId,
            fields.name,
            fields.mediaType,
            fields.byteLength,
            fields.sha256,
            fields.createdAt,
            validateTimestamp(stringField(artifact, "expiredAt", 128), "expiredAt"),
        );
    }
    throw invalidResponse("The service returned an invalid artifact state");
}

export function decodeMobiusAvailableArtifact(value: unknown): MobiusAvailableArtifact {
    const artifact = decodeMobiusArtifact(value);
    if (!(artifact instanceof MobiusAvailableArtifact)) {
        throw invalidResponse("The service did not make the artifact available");
    }
    return artifact;
}

export class MobiusArtifactDownload {
    readonly artifact: MobiusAvailableArtifact;
    readonly bytes: Uint8Array;

    constructor(artifact: MobiusAvailableArtifact, bytes: Uint8Array) {
        this.artifact = artifact;
        this.bytes = bytes;
    }
}

export class MobiusBrowserCredential {
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly projectId: string;
    readonly tenantId: string;
    readonly token: string;

    constructor(credentialId: string, expiresAt: string, projectId: string, tenantId: string, token: string) {
        this.credentialId = credentialId;
        this.expiresAt = expiresAt;
        this.projectId = projectId;
        this.tenantId = tenantId;
        this.token = token;
    }
}

export function decodeMobiusBrowserCredential(value: unknown): MobiusBrowserCredential {
    const credential = record(value, "browser credential");
    return new MobiusBrowserCredential(
        identifierField(credential, "credentialId"),
        validateTimestamp(stringField(credential, "expiresAt", 128), "expiresAt"),
        identifierField(credential, "projectId"),
        identifierField(credential, "tenantId"),
        stringField(credential, "token", 256),
    );
}

export class MobiusAgentDescriptor {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly id: string;
    readonly label: string;

    constructor(agentPath: string, agentVersion: string, capabilities: SessionCapabilities, id: string, label: string) {
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.id = id;
        this.label = label;
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
        Object.keys(agent).length !== 5 ||
        !Object.hasOwn(agent, "agentPath") ||
        !Object.hasOwn(agent, "agentVersion") ||
        !Object.hasOwn(agent, "capabilities") ||
        !Object.hasOwn(agent, "id") ||
        !Object.hasOwn(agent, "label")
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
    readonly tenantId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        installableAgents: readonly MobiusInstallableAgentDescriptor[],
        machineName: string,
        online: boolean,
        projectId: string,
        runtimeId: string,
        tenantId: string,
        workspaceName: string,
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.online = online;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.tenantId = tenantId;
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
        identifierField(runtime, "tenantId"),
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
    readonly tenantId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        installableAgents: readonly MobiusInstallableAgentDescriptor[],
        machineName: string,
        projectId: string,
        runtimeId: string,
        tenantId: string,
        workspaceName: string,
    ) {
        super();
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.tenantId = tenantId;
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
            identifierField(status, "tenantId"),
            stringField(status, "workspaceName", 255),
        );
    }
    throw invalidResponse("The service returned an unsupported Runtime pairing status");
}

export abstract class MobiusInteractionResponseRequest {
    abstract readonly kind: string;
    readonly responderId: string;

    constructor(responderId: string) {
        this.responderId = responderId;
    }
}

export class MobiusPermissionResponseRequest extends MobiusInteractionResponseRequest {
    readonly kind = "permission";
    readonly optionId: string;
    readonly outcome: string;

    constructor(responderId: string, outcome: string, optionId: string) {
        super(responderId);
        this.optionId = optionId;
        this.outcome = outcome;
    }
}

export class MobiusElicitationResponseRequest extends MobiusInteractionResponseRequest {
    readonly action: string;
    readonly content: string;
    readonly kind = "elicitation";

    constructor(responderId: string, action: string, content: string) {
        super(responderId);
        this.action = action;
        this.content = content;
    }
}

export function decodeMobiusInteraction(value: unknown): Interaction {
    try {
        return decodeInteraction(value);
    } catch (cause) {
        throw new MobiusProtocolError("The service returned an invalid Interaction", { cause });
    }
}

export function decodeMobiusInteractionList(value: unknown): readonly Interaction[] {
    const response = record(value, "Interaction list");
    return arrayField(response, "interactions", 100).map(decodeMobiusInteraction);
}

export class MobiusPageRequest {
    readonly cursor: string;
    readonly limit: number;

    constructor(limit: number, cursor: string) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor.length > 512) {
            throw new MobiusValidationError("The page request is invalid");
        }
        this.cursor = cursor;
        this.limit = limit;
    }
}

export class MobiusSessionBinding {
    readonly agentRef: string;
    readonly bindingId: string;
    readonly configRevision: number;
    readonly createdAt: string;
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly workspaceRef: string;

    constructor(
        agentRef: string,
        bindingId: string,
        configRevision: number,
        createdAt: string,
        runtimeId: string,
        sessionId: string,
        workspaceRef: string,
    ) {
        this.agentRef = agentRef;
        this.bindingId = bindingId;
        this.configRevision = configRevision;
        this.createdAt = createdAt;
        this.runtimeId = runtimeId;
        this.sessionId = sessionId;
        this.workspaceRef = workspaceRef;
    }
}

export abstract class MobiusSessionState {
    abstract readonly kind: string;
}

export class MobiusReadySessionState extends MobiusSessionState {
    readonly kind = "ready";
}

export class MobiusDeletingSessionState extends MobiusSessionState {
    readonly kind = "deleting";
    readonly requestedAt: string;

    constructor(requestedAt: string) {
        super();
        this.requestedAt = requestedAt;
    }
}

export class MobiusDeletedSessionState extends MobiusSessionState {
    readonly completedAt: string;
    readonly kind = "deleted";

    constructor(completedAt: string) {
        super();
        this.completedAt = completedAt;
    }
}

export class MobiusSession {
    readonly agentId: string;
    readonly createdAt: string;
    readonly createdBy: string;
    readonly defaultBinding: MobiusSessionBinding;
    readonly hasNativeHistory: boolean;
    readonly lastCommittedSequence: string;
    readonly policy: MobiusRecordingPolicy;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly state: MobiusSessionState;
    readonly tenantId: string;
    readonly title: string;
    readonly updatedAt: string;

    constructor(
        agentId: string,
        createdAt: string,
        createdBy: string,
        defaultBinding: MobiusSessionBinding,
        hasNativeHistory: boolean,
        lastCommittedSequence: string,
        policy: MobiusRecordingPolicy,
        projectId: string,
        runtimeId: string,
        sessionId: string,
        state: MobiusSessionState,
        tenantId: string,
        title: string,
        updatedAt: string,
    ) {
        this.agentId = agentId;
        this.createdAt = createdAt;
        this.createdBy = createdBy;
        this.defaultBinding = defaultBinding;
        this.hasNativeHistory = hasNativeHistory;
        this.lastCommittedSequence = lastCommittedSequence;
        this.policy = policy;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.sessionId = sessionId;
        this.state = state;
        this.tenantId = tenantId;
        this.title = title;
        this.updatedAt = updatedAt;
    }
}

export function decodeMobiusSessionState(value: unknown): MobiusSessionState {
    const state = record(value, "Session lifecycle");
    const kind = stringField(state, "kind", 32);
    if (kind === "ready") {
        return new MobiusReadySessionState();
    }
    if (kind === "deleting") {
        return new MobiusDeletingSessionState(validateTimestamp(stringField(state, "requestedAt", 128), "requestedAt"));
    }
    if (kind === "deleted") {
        return new MobiusDeletedSessionState(validateTimestamp(stringField(state, "completedAt", 128), "completedAt"));
    }
    throw invalidResponse("The service returned an unsupported Session lifecycle");
}

function decodeBinding(value: unknown): MobiusSessionBinding {
    const binding = record(value, "Session binding");
    return new MobiusSessionBinding(
        identifierField(binding, "agentRef"),
        identifierField(binding, "bindingId"),
        integerField(binding, "configRevision"),
        validateTimestamp(stringField(binding, "createdAt", 128), "createdAt"),
        identifierField(binding, "runtimeId"),
        identifierField(binding, "sessionId"),
        identifierField(binding, "workspaceRef"),
    );
}

function decodeRecordingPolicy(value: unknown): MobiusRecordingPolicy {
    const policy = record(value, "Session recording policy");
    return new MobiusRecordingPolicy(
        stringField(policy, "level", 32),
        integerField(policy, "retentionMilliseconds"),
        integerField(policy, "hotEventLimit"),
        integerField(policy, "contentLimitBytes"),
        integerField(policy, "idempotencyRetentionMilliseconds"),
    );
}

export function decodeMobiusSession(value: unknown): MobiusSession {
    const session = record(value, "Session");
    const sequence = stringField(session, "lastCommittedSeq", 40);
    if (!/^(?:0|[1-9][0-9]*)$/.test(sequence)) {
        throw invalidResponse("The service returned an invalid event sequence");
    }
    return new MobiusSession(
        identifierField(session, "agentId"),
        validateTimestamp(stringField(session, "createdAt", 128), "createdAt"),
        identifierField(session, "createdBy"),
        decodeBinding(session["defaultBinding"]),
        booleanField(session, "hasNativeHistory"),
        sequence,
        decodeRecordingPolicy(session["policy"]),
        identifierField(session, "projectId"),
        identifierField(session, "runtimeId"),
        identifierField(session, "sessionId"),
        decodeMobiusSessionState(session["lifecycle"]),
        identifierField(session, "tenantId"),
        stringField(session, "title", 500),
        validateTimestamp(stringField(session, "updatedAt", 128), "updatedAt"),
    );
}

export class MobiusSessionPage {
    readonly nextCursor: string;
    readonly sessions: readonly MobiusSession[];

    constructor(sessions: readonly MobiusSession[], nextCursor: string) {
        this.nextCursor = nextCursor;
        this.sessions = sessions;
    }
}

export function decodeMobiusSessionPage(value: unknown): MobiusSessionPage {
    const page = record(value, "Session page");
    return new MobiusSessionPage(
        arrayField(page, "sessions", 100).map(decodeMobiusSession),
        nullableCursor(page, "nextCursor"),
    );
}

export abstract class MobiusTurnState {
    abstract readonly kind: string;
}

export class MobiusQueuedTurnState extends MobiusTurnState {
    readonly kind = "queued";
}

export class MobiusRunningTurnState extends MobiusTurnState {
    readonly kind = "running";
    readonly startedAt: string;

    constructor(startedAt: string) {
        super();
        this.startedAt = startedAt;
    }
}

export class MobiusSucceededTurnState extends MobiusTurnState {
    readonly completedAt: string;
    readonly kind = "succeeded";
    readonly stopReason: string;

    constructor(completedAt: string, stopReason: string) {
        super();
        this.completedAt = completedAt;
        this.stopReason = stopReason;
    }
}

export class MobiusFailedTurnState extends MobiusTurnState {
    readonly code: string;
    readonly failedAt: string;
    readonly kind = "failed";
    readonly message: string;
    readonly retryable: boolean;

    constructor(failedAt: string, code: string, message: string, retryable: boolean) {
        super();
        this.code = code;
        this.failedAt = failedAt;
        this.message = message;
        this.retryable = retryable;
    }
}

export class MobiusCancelledTurnState extends MobiusTurnState {
    readonly cancelledAt: string;
    readonly kind = "cancelled";

    constructor(cancelledAt: string) {
        super();
        this.cancelledAt = cancelledAt;
    }
}

export class MobiusIndeterminateTurnState extends MobiusTurnState {
    readonly detectedAt: string;
    readonly kind = "indeterminate";
    readonly reason: string;

    constructor(detectedAt: string, reason: string) {
        super();
        this.detectedAt = detectedAt;
        this.reason = reason;
    }
}

export class MobiusTurn {
    readonly acceptedAt: string;
    readonly bindingId: string;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly sessionId: string;
    readonly state: MobiusTurnState;
    readonly turnId: string;

    constructor(
        acceptedAt: string,
        bindingId: string,
        content: string,
        idempotencyKey: string,
        sessionId: string,
        state: MobiusTurnState,
        turnId: string,
    ) {
        this.acceptedAt = acceptedAt;
        this.bindingId = bindingId;
        this.content = content;
        this.idempotencyKey = idempotencyKey;
        this.sessionId = sessionId;
        this.state = state;
        this.turnId = turnId;
    }
}

export function decodeMobiusTurn(value: unknown): MobiusTurn {
    const turn = decodeTurn(value);
    let state: MobiusTurnState;
    switch (turn.state.kind) {
        case "queued":
            state = new MobiusQueuedTurnState();
            break;
        case "running":
            state = new MobiusRunningTurnState(turn.state.startedAt);
            break;
        case "succeeded":
            state = new MobiusSucceededTurnState(turn.state.completedAt, turn.state.result.stopReason);
            break;
        case "failed":
            state = new MobiusFailedTurnState(
                turn.state.failedAt,
                turn.state.error.code,
                turn.state.error.message,
                turn.state.error.retryable,
            );
            break;
        case "cancelled":
            state = new MobiusCancelledTurnState(turn.state.cancelledAt);
            break;
        case "indeterminate":
            state = new MobiusIndeterminateTurnState(
                turn.state.reconciliation.detectedAt,
                turn.state.reconciliation.reason,
            );
            break;
    }
    return new MobiusTurn(
        turn.acceptedAt,
        turn.bindingId,
        turn.request.content,
        turn.idempotencyKey,
        turn.sessionId,
        state,
        turn.turnId,
    );
}

export function decodeMobiusAttempt(value: unknown): Attempt {
    try {
        return decodeAttempt(value);
    } catch (cause) {
        throw new MobiusProtocolError("The service returned an invalid Attempt", {
            cause,
        });
    }
}

export abstract class MobiusAttemptSummary {
    abstract readonly kind: string;
}

export class MobiusNoAttemptSummary extends MobiusAttemptSummary {
    readonly kind = "none";
}

export abstract class MobiusPresentAttemptSummary extends MobiusAttemptSummary {
    readonly attemptId: string;

    constructor(attemptId: string) {
        super();
        this.attemptId = attemptId;
    }
}

export class MobiusDispatchingAttemptSummary extends MobiusPresentAttemptSummary {
    readonly dispatchedAt: string;
    readonly kind = "dispatching";

    constructor(attemptId: string, dispatchedAt: string) {
        super(attemptId);
        this.dispatchedAt = dispatchedAt;
    }
}

export class MobiusRunningAttemptSummary extends MobiusPresentAttemptSummary {
    readonly kind = "running";
    readonly startedAt: string;

    constructor(attemptId: string, startedAt: string) {
        super(attemptId);
        this.startedAt = startedAt;
    }
}

export class MobiusSucceededAttemptSummary extends MobiusPresentAttemptSummary {
    readonly completedAt: string;
    readonly kind = "succeeded";
    readonly startedAt: string;
    readonly stopReason: string;

    constructor(attemptId: string, startedAt: string, completedAt: string, stopReason: string) {
        super(attemptId);
        this.completedAt = completedAt;
        this.startedAt = startedAt;
        this.stopReason = stopReason;
    }
}

export class MobiusCancelledAttemptSummary extends MobiusPresentAttemptSummary {
    readonly cancelledAt: string;
    readonly kind = "cancelled";
    readonly startedAt: string;

    constructor(attemptId: string, startedAt: string, cancelledAt: string) {
        super(attemptId);
        this.cancelledAt = cancelledAt;
        this.startedAt = startedAt;
    }
}

export class MobiusWaitingInputAttemptSummary extends MobiusPresentAttemptSummary {
    readonly interactionIds: readonly string[];
    readonly kind = "waiting_input";
    readonly startedAt: string;

    constructor(attemptId: string, startedAt: string, interactionIds: readonly string[]) {
        super(attemptId);
        this.interactionIds = interactionIds;
        this.startedAt = startedAt;
    }
}

export class MobiusFailedBeforeStartAttemptSummary extends MobiusAttemptSummary {
    readonly code: string;
    readonly failedAt: string;
    readonly kind = "failed";
    readonly message: string;

    constructor(code: string, message: string, failedAt: string) {
        super();
        this.code = code;
        this.failedAt = failedAt;
        this.message = message;
    }
}

export class MobiusFailedAttemptSummary extends MobiusPresentAttemptSummary {
    readonly code: string;
    readonly failedAt: string;
    readonly kind = "failed";
    readonly message: string;
    readonly startedAt: string;

    constructor(attemptId: string, startedAt: string, code: string, message: string, failedAt: string) {
        super(attemptId);
        this.code = code;
        this.failedAt = failedAt;
        this.message = message;
        this.startedAt = startedAt;
    }
}

export class MobiusIndeterminateAttemptSummary extends MobiusPresentAttemptSummary {
    readonly detectedAt: string;
    readonly kind = "indeterminate";
    readonly startedAt: string;

    constructor(attemptId: string, startedAt: string, detectedAt: string) {
        super(attemptId);
        this.detectedAt = detectedAt;
        this.startedAt = startedAt;
    }
}

function decodeAttemptSummary(value: unknown): MobiusAttemptSummary {
    if (value === null) {
        return new MobiusNoAttemptSummary();
    }
    const attempt = record(value, "Attempt summary");
    const kind = stringField(attempt, "kind", 32);
    if (kind === "failed") {
        const attemptId = attempt["attemptId"];
        const startedAt = attempt["startedAt"];
        const code = identifierField(attempt, "code");
        const message = stringField(attempt, "message", 2_000);
        const failedAt = validateTimestamp(stringField(attempt, "failedAt", 128), "failedAt");
        if (attemptId === null && startedAt === null) {
            return new MobiusFailedBeforeStartAttemptSummary(code, message, failedAt);
        }
        if (typeof attemptId !== "string" || typeof startedAt !== "string") {
            throw invalidResponse("The service returned an invalid failed Attempt");
        }
        return new MobiusFailedAttemptSummary(
            attemptId,
            validateTimestamp(startedAt, "startedAt"),
            code,
            message,
            failedAt,
        );
    }
    const attemptId = identifierField(attempt, "attemptId");
    if (kind === "dispatching") {
        return new MobiusDispatchingAttemptSummary(
            attemptId,
            validateTimestamp(stringField(attempt, "dispatchedAt", 128), "dispatchedAt"),
        );
    }
    const startedAt = validateTimestamp(stringField(attempt, "startedAt", 128), "startedAt");
    if (kind === "running") {
        return new MobiusRunningAttemptSummary(attemptId, startedAt);
    }
    if (kind === "succeeded") {
        return new MobiusSucceededAttemptSummary(
            attemptId,
            startedAt,
            validateTimestamp(stringField(attempt, "completedAt", 128), "completedAt"),
            stringField(attempt, "stopReason", 128),
        );
    }
    if (kind === "cancelled") {
        return new MobiusCancelledAttemptSummary(
            attemptId,
            startedAt,
            validateTimestamp(stringField(attempt, "cancelledAt", 128), "cancelledAt"),
        );
    }
    if (kind === "waiting_input") {
        return new MobiusWaitingInputAttemptSummary(
            attemptId,
            startedAt,
            arrayField(attempt, "interactionIds", 100).map((interactionId) => {
                if (typeof interactionId !== "string") {
                    throw invalidResponse("The service returned an invalid interaction identifier");
                }
                return identifierField({ interactionId }, "interactionId");
            }),
        );
    }
    if (kind === "indeterminate") {
        return new MobiusIndeterminateAttemptSummary(
            attemptId,
            startedAt,
            validateTimestamp(stringField(attempt, "detectedAt", 128), "detectedAt"),
        );
    }
    throw invalidResponse("The service returned an unsupported Attempt state");
}

export class MobiusActivitySummary {
    readonly activityId: string;
    readonly attemptId: string;
    readonly activityType: string;
    readonly detailAvailability: string;
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolCallId: string;
    readonly toolKind: string;

    constructor(
        activityId: string,
        attemptId: string,
        activityType: string,
        detailAvailability: string,
        input: string,
        locations: readonly string[],
        name: string,
        output: string,
        sequence: number,
        status: string,
        title: string,
        toolCallId: string,
        toolKind: string,
    ) {
        this.activityId = activityId;
        this.attemptId = attemptId;
        this.activityType = activityType;
        this.detailAvailability = detailAvailability;
        this.input = input;
        this.locations = locations;
        this.name = name;
        this.output = output;
        this.sequence = sequence;
        this.status = status;
        this.title = title;
        this.toolCallId = toolCallId;
        this.toolKind = toolKind;
    }
}

function decodeActivitySummary(value: unknown): MobiusActivitySummary {
    const activity = record(value, "Activity summary");
    return new MobiusActivitySummary(
        identifierField(activity, "activityId"),
        identifierField(activity, "attemptId"),
        stringField(activity, "activityType", 128),
        stringField(activity, "detailAvailability", 32),
        stringField(activity, "input", 100_000),
        arrayField(activity, "locations", 100).map((location) => {
            if (typeof location !== "string" || location.length > 2_048) {
                throw invalidResponse("The service returned an invalid Activity location");
            }
            return location;
        }),
        stringField(activity, "name", 128),
        stringField(activity, "output", 100_000),
        integerField(activity, "sequence"),
        stringField(activity, "status", 64),
        stringField(activity, "title", 500),
        identifierField(activity, "toolCallId"),
        stringField(activity, "toolKind", 128),
    );
}

export class MobiusMessage {
    readonly activities: readonly MobiusActivitySummary[];
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly attempt: MobiusAttemptSummary;
    readonly commandId: string;
    readonly createdAt: string;
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
    readonly response: string;
    readonly sessionId: string;

    constructor(
        activities: readonly MobiusActivitySummary[],
        additionalDirectoryIds: readonly string[],
        agentId: string,
        attempt: MobiusAttemptSummary,
        commandId: string,
        createdAt: string,
        images: readonly PromptImage[],
        prompt: string,
        resources: readonly PromptResource[],
        response: string,
        sessionId: string,
    ) {
        this.activities = activities;
        this.additionalDirectoryIds = additionalDirectoryIds;
        this.agentId = agentId;
        this.attempt = attempt;
        this.commandId = commandId;
        this.createdAt = createdAt;
        this.images = images;
        this.prompt = prompt;
        this.resources = resources;
        this.response = response;
        this.sessionId = sessionId;
    }
}

function decodeMobiusMessage(value: unknown): MobiusMessage {
    const message = record(value, "Session message");
    return new MobiusMessage(
        arrayField(message, "activities", 10_000).map(decodeActivitySummary),
        arrayField(message, "additionalDirectoryIds", 100).map((directoryId) => {
            if (typeof directoryId !== "string") {
                throw invalidResponse("The service returned an invalid additional directory identifier");
            }
            return identifierField({ directoryId }, "directoryId");
        }),
        identifierField(message, "agentId"),
        decodeAttemptSummary(message["attempt"]),
        identifierField(message, "commandId"),
        validateTimestamp(stringField(message, "createdAt", 128), "createdAt"),
        decodePromptImagesValue(message["images"]),
        stringField(message, "prompt", 100_000),
        decodePromptResourcesValue(message["resources"]),
        stringField(message, "response", 8_500_000),
        identifierField(message, "sessionId"),
    );
}

export class MobiusMessagePage {
    readonly lastCommittedSequence: string;
    readonly messages: readonly MobiusMessage[];
    readonly nextCursor: string;

    constructor(lastCommittedSequence: string, messages: readonly MobiusMessage[], nextCursor: string) {
        this.lastCommittedSequence = lastCommittedSequence;
        this.messages = messages;
        this.nextCursor = nextCursor;
    }
}

export function decodeMobiusMessagePage(value: unknown): MobiusMessagePage {
    const page = record(value, "Session message page");
    const sequence = stringField(page, "lastCommittedSeq", 40);
    if (!/^(?:0|[1-9][0-9]*)$/.test(sequence)) {
        throw invalidResponse("The service returned an invalid event sequence");
    }
    return new MobiusMessagePage(
        sequence,
        arrayField(page, "messages", 100).map(decodeMobiusMessage),
        nullableCursor(page, "nextCursor"),
    );
}

export abstract class MobiusToolCallDetail {
    abstract readonly kind: string;
}

export class MobiusAvailableToolCallDetail extends MobiusToolCallDetail {
    readonly artifactId: string;
    readonly content: readonly unknown[];
    readonly input: string;
    readonly kind = "available";
    readonly output: string;
    readonly storage: string;

    constructor(artifactId: string, content: readonly unknown[], input: string, output: string, storage: string) {
        super();
        this.artifactId = artifactId;
        this.content = content;
        this.input = input;
        this.output = output;
        this.storage = storage;
    }
}

export class MobiusTruncatedToolCallDetail extends MobiusToolCallDetail {
    readonly capturedBytes: number;
    readonly kind = "truncated";
    readonly originalBytes: number;

    constructor(capturedBytes: number, originalBytes: number) {
        super();
        this.capturedBytes = capturedBytes;
        this.originalBytes = originalBytes;
    }
}

export class MobiusUnrecordedToolCallDetail extends MobiusToolCallDetail {
    readonly kind = "unrecorded";
}

export class MobiusDeletedToolCallDetail extends MobiusToolCallDetail {
    readonly deletedAt: string;
    readonly kind = "deleted";

    constructor(deletedAt: string) {
        super();
        this.deletedAt = deletedAt;
    }
}

export function decodeMobiusToolCallDetail(value: unknown): MobiusToolCallDetail {
    const detail = record(value, "ToolCall detail");
    const kind = stringField(detail, "kind", 32);
    if (kind === "available") {
        const storage = stringField(detail, "storage", 32);
        if (storage !== "archive" && storage !== "hot") {
            throw invalidResponse("The service returned an invalid ToolCall storage state");
        }
        return new MobiusAvailableToolCallDetail(
            identifierField(detail, "artifactId"),
            arrayField(detail, "content", 100_000),
            stringField(detail, "input"),
            stringField(detail, "output"),
            storage,
        );
    }
    if (kind === "truncated") {
        return new MobiusTruncatedToolCallDetail(
            integerField(detail, "capturedBytes"),
            integerField(detail, "originalBytes"),
        );
    }
    if (kind === "unrecorded") {
        return new MobiusUnrecordedToolCallDetail();
    }
    if (kind === "deleted") {
        return new MobiusDeletedToolCallDetail(validateTimestamp(stringField(detail, "deletedAt", 128), "deletedAt"));
    }
    throw invalidResponse("The service returned an invalid ToolCall detail");
}

export class MobiusEventPage {
    readonly cursor: string;
    readonly events: readonly MobiusSessionEvent[];
    readonly hasMore: boolean;

    constructor(cursor: string, events: readonly MobiusSessionEvent[], hasMore: boolean) {
        this.cursor = cursor;
        this.events = events;
        this.hasMore = hasMore;
    }
}

export function decodeMobiusEventPage(value: unknown): MobiusEventPage {
    const page = record(value, "Session event page");
    return new MobiusEventPage(
        stringField(page, "cursor", 512),
        arrayField(page, "events", 100).map(decodeMobiusSessionEvent),
        booleanField(page, "hasMore"),
    );
}

export class MobiusSessionExport {
    readonly formatVersion: string;
    readonly session: Readonly<Record<string, unknown>>;

    constructor(formatVersion: string, session: Readonly<Record<string, unknown>>) {
        this.formatVersion = formatVersion;
        this.session = session;
    }
}

export function decodeMobiusSessionExport(value: unknown): MobiusSessionExport {
    const exported = record(value, "Session export");
    const formatVersion = stringField(exported, "formatVersion", 32);
    if (formatVersion !== MOBIUS_SESSION_EXPORT_FORMAT_VERSION) {
        throw invalidResponse("The service returned an unsupported Session export");
    }
    return new MobiusSessionExport(formatVersion, record(exported["session"], "Session export payload"));
}

export abstract class MobiusEventSource {
    abstract readonly kind: string;
    readonly sourceSequence: string;

    constructor(sourceSequence: string) {
        this.sourceSequence = sourceSequence;
    }
}

export class MobiusRuntimeEventSource extends MobiusEventSource {
    readonly kind = "runtime";
}

export class MobiusAttemptEventSource extends MobiusEventSource {
    readonly attemptId: string;
    readonly kind = "attempt";

    constructor(attemptId: string, sourceSequence: string) {
        super(sourceSequence);
        this.attemptId = attemptId;
    }
}

export abstract class MobiusRecordedEvent {
    abstract readonly kind: string;
    readonly sessionId: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }
}

export class MobiusTurnStartedEvent extends MobiusRecordedEvent {
    readonly attemptId: string;
    readonly commandId: string;
    readonly kind = SESSION_STARTED_KIND;

    constructor(sessionId: string, commandId: string, attemptId: string) {
        super(sessionId);
        this.attemptId = attemptId;
        this.commandId = commandId;
    }
}

export class MobiusAgentMessageEvent extends MobiusRecordedEvent {
    readonly commandId: string;
    readonly kind = AGENT_MESSAGE_DELTA_KIND;
    readonly text: string;

    constructor(sessionId: string, commandId: string, text: string) {
        super(sessionId);
        this.commandId = commandId;
        this.text = text;
    }
}

export class MobiusAgentActivityEvent extends MobiusRecordedEvent {
    readonly activityId: string;
    readonly activityType: string;
    readonly commandId: string;
    readonly content: AgentActivityEvent["content"];
    readonly detail: AgentActivityEvent["detail"];
    readonly input: string;
    readonly kind = AGENT_ACTIVITY_KIND;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;

    constructor(event: AgentActivityEvent) {
        super(event.sessionId);
        this.activityId = event.activityId;
        this.activityType = event.activityType;
        this.commandId = event.commandId;
        this.content = event.content;
        this.detail = event.detail;
        this.input = event.input;
        this.locations = event.locations;
        this.name = event.name;
        this.output = event.output;
        this.sequence = event.sequence;
        this.status = event.status;
        this.title = event.title;
        this.toolKind = event.toolKind;
    }
}

export class MobiusTurnCompletedEvent extends MobiusRecordedEvent {
    readonly commandId: string;
    readonly kind = SESSION_COMPLETED_KIND;
    readonly stopReason: string;

    constructor(sessionId: string, commandId: string, stopReason: string) {
        super(sessionId);
        this.commandId = commandId;
        this.stopReason = stopReason;
    }
}

export class MobiusTurnFailedEvent extends MobiusRecordedEvent {
    readonly code: string;
    readonly commandId: string;
    readonly kind = SESSION_FAILED_KIND;
    readonly message: string;

    constructor(sessionId: string, commandId: string, code: string, message: string) {
        super(sessionId);
        this.code = code;
        this.commandId = commandId;
        this.message = message;
    }
}

export class MobiusControlEvent extends MobiusRecordedEvent {
    readonly encodedPayload: string;
    readonly kind: string;

    constructor(sessionId: string, kind: string, encodedPayload: string) {
        super(sessionId);
        this.encodedPayload = encodedPayload;
        this.kind = kind;
    }
}

function decodeRecordedEvent(encoded: string): MobiusRecordedEvent {
    const event = decodeRecordedSessionEvent(encoded);
    switch (event.kind) {
        case SESSION_STARTED_KIND:
            return new MobiusTurnStartedEvent(event.sessionId, event.commandId, event.attemptId);
        case AGENT_MESSAGE_DELTA_KIND:
            return new MobiusAgentMessageEvent(event.sessionId, event.commandId, event.text);
        case AGENT_ACTIVITY_KIND:
            return new MobiusAgentActivityEvent(event);
        case SESSION_COMPLETED_KIND:
            return new MobiusTurnCompletedEvent(event.sessionId, event.commandId, event.stopReason);
        case SESSION_FAILED_KIND:
            return new MobiusTurnFailedEvent(event.sessionId, event.commandId, event.code, event.message);
        default:
            return new MobiusControlEvent(event.sessionId, event.kind, encoded);
    }
}

export class MobiusSessionEvent {
    readonly cursor: string;
    readonly eventId: string;
    readonly payload: MobiusRecordedEvent;
    readonly recordedAt: string;
    readonly sequence: string;
    readonly sessionId: string;
    readonly source: MobiusEventSource;

    constructor(
        cursor: string,
        eventId: string,
        payload: MobiusRecordedEvent,
        recordedAt: string,
        sequence: string,
        sessionId: string,
        source: MobiusEventSource,
    ) {
        this.cursor = cursor;
        this.eventId = eventId;
        this.payload = payload;
        this.recordedAt = recordedAt;
        this.sequence = sequence;
        this.sessionId = sessionId;
        this.source = source;
    }
}

export function decodeMobiusSessionEvent(value: unknown): MobiusSessionEvent {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
        throw invalidResponse("The service returned an invalid Session event");
    }
    const event = decodeCommittedSessionEvent(encoded);
    const source =
        event.source.kind === "attempt"
            ? new MobiusAttemptEventSource(event.source.attemptId, event.source.sourceSeq)
            : new MobiusRuntimeEventSource(event.source.sourceSeq);
    return new MobiusSessionEvent(
        event.cursor,
        event.eventId,
        decodeRecordedEvent(event.payload),
        event.recordedAt,
        event.sequence,
        event.sessionId,
        source,
    );
}
