import {
    decodeIdentifier,
    decodeTurn,
    type Identifier,
    isIdentifier,
    type PromptAttachment,
    type SessionCapabilities,
    type SessionConfigurationSelection,
    type SessionHistoryPolicy,
    type TurnRequest,
} from "@moxt-ai/mobius-sdk/protocol";

import { MobiusProtocolError, MobiusValidationError } from "./errors.ts";

// The capabilities this SDK build understands. A newer service may advertise
// additional capabilities; unknown fields are ignored and missing fields default
// to unsupported, so the SDK never rejects a service for evolving the protocol.
const KNOWN_SESSION_CAPABILITY_FIELDS: readonly (keyof SessionCapabilities)[] = [
    "additionalDirectories",
    "audioPrompt",
    "closeSession",
    "deleteSession",
    "embeddedContextPrompt",
    "imagePrompt",
    "listSessions",
    "loadSession",
    "promptQueueing",
    "renameSession",
    "resumeSession",
    "steering",
    "unstableForkSession",
];

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
        renameSession: false,
        resumeSession: false,
        steering: false,
        unstableForkSession: false,
    });
}

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

function identifierField(value: Readonly<Record<string, unknown>>, field: string): Identifier {
    try {
        return decodeIdentifier(value[field]);
    } catch {
        throw invalidResponse(`The service returned an invalid ${field}`);
    }
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

export class MobiusSessionAccess {
    readonly credential: string;
    readonly credentialId: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly expiresAt: string;
    constructor(value: unknown) {
        const resource = record(value, "Session access");
        this.credential = stringField(resource, "credential", 2_048);
        if (!/^msession_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/u.test(this.credential)) {
            throw invalidResponse("The Session credential is invalid");
        }
        this.credentialId = identifierField(resource, "credentialId");
        this.projectId = identifierField(resource, "projectId");
        this.sessionId = identifierField(resource, "sessionId");
        this.expiresAt = validateTimestamp(stringField(resource, "expiresAt", 128), "expiresAt");
    }
}

export interface CreateMobiusSessionRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

export interface SubmitMobiusTurnRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly attachments: readonly PromptAttachment[];
    readonly content: string;
    readonly disposition?: string;
    readonly idempotencyKey: string;
    readonly historyPolicy?: SessionHistoryPolicy;
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly targetCommandId?: string;
}

/** How a cancelled Turn ended: `cancelled`, or the Agent's stop reason when the Turn finished first. */
export interface MobiusTurnCancellation {
    readonly turnId: string;
    readonly stopReason: string;
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
        if (!isIdentifier(idempotencyKey)) {
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

export class MobiusChannelAccessGrant {
    readonly expiresAt: string;
    readonly grantId: string;
    readonly grantSecret: string;

    constructor(grantId: string, grantSecret: string, expiresAt: string) {
        this.expiresAt = expiresAt;
        this.grantId = grantId;
        this.grantSecret = grantSecret;
    }
}

export function decodeMobiusChannelAccessGrant(value: unknown): MobiusChannelAccessGrant {
    const grant = record(value, "channel access grant");
    const grantSecret = stringField(grant, "grantSecret", 256);
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(grantSecret)) {
        throw invalidResponse("The service returned an invalid channel access grant");
    }
    return new MobiusChannelAccessGrant(
        identifierField(grant, "grantId"),
        grantSecret,
        validateTimestamp(stringField(grant, "expiresAt", 128), "expiresAt"),
    );
}

export class MobiusLinkedChannelDevice {
    readonly createdAt: string;
    readonly credentialId: string;
    readonly lastUsedAt: string;

    constructor(credentialId: string, createdAt: string, lastUsedAt: string) {
        this.createdAt = createdAt;
        this.credentialId = credentialId;
        this.lastUsedAt = lastUsedAt;
    }
}

function decodeMobiusLinkedChannelDevice(value: unknown): MobiusLinkedChannelDevice {
    const device = record(value, "linked channel device");
    return new MobiusLinkedChannelDevice(
        identifierField(device, "credentialId"),
        validateTimestamp(stringField(device, "createdAt", 128), "createdAt"),
        validateTimestamp(stringField(device, "lastUsedAt", 128), "lastUsedAt"),
    );
}

export function decodeMobiusLinkedChannelDeviceList(value: unknown): readonly MobiusLinkedChannelDevice[] {
    const response = record(value, "linked channel device list");
    const devices = arrayField(response, "devices", 1_000).map(decodeMobiusLinkedChannelDevice);
    if (new Set(devices.map((device) => device.credentialId)).size !== devices.length) {
        throw invalidResponse("The service returned duplicate linked channel devices");
    }
    return devices;
}

export class MobiusRedeemedChannelCredential {
    readonly channelId: string;
    readonly hostToken: string;
    readonly projectId: string;

    constructor(channelId: string, hostToken: string, projectId: string) {
        this.channelId = channelId;
        this.hostToken = hostToken;
        this.projectId = projectId;
    }
}

export function decodeMobiusRedeemedChannelCredential(value: unknown): MobiusRedeemedChannelCredential {
    const credential = record(value, "redeemed channel credential");
    const hostToken = stringField(credential, "hostToken", 256);
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(hostToken)) {
        throw invalidResponse("The service returned an invalid channel credential");
    }
    return new MobiusRedeemedChannelCredential(
        identifierField(credential, "channelId"),
        hostToken,
        identifierField(credential, "projectId"),
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

// Decodes capabilities without depending on zod's strip/default semantics: the
// shape is validated explicitly into a fresh object, unknown fields are ignored,
// and missing known fields default to unsupported. This keeps an older SDK
// compatible with a newer service that advertises capabilities it does not know.
export function decodeMobiusAgentCapabilities(value: unknown): SessionCapabilities {
    const capabilities = record(value, "Agent capabilities");
    const decoded: Record<keyof SessionCapabilities, boolean> = { ...unsupportedSessionCapabilities() };
    for (const field of KNOWN_SESSION_CAPABILITY_FIELDS) {
        if (!Object.hasOwn(capabilities, field)) {
            continue;
        }
        const advertised = capabilities[field];
        if (advertised !== undefined && typeof advertised !== "boolean") {
            throw invalidResponse("The service returned invalid Agent capabilities");
        }
        decoded[field] = advertised === true;
    }
    return Object.freeze(decoded);
}

function decodeAgentDescriptor(value: unknown): MobiusAgentDescriptor {
    const agent = record(value, "Agent descriptor");
    // Fields a newer service adds are ignored, so an older SDK can still list the Agent.
    if (
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

export class MobiusRuntimeDescriptor {
    readonly agents: readonly MobiusAgentDescriptor[];
    readonly channelId: string;
    readonly machineName: string;
    readonly online: boolean;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        machineName: string,
        online: boolean,
        projectId: string,
        runtimeId: string,
        workspaceName: string,
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.machineName = machineName;
        this.online = online;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

export class MobiusChannelDescriptor {
    readonly agents: readonly MobiusAgentDescriptor[];
    readonly channelId: string;
    readonly machineName: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        machineName: string,
        projectId: string,
        runtimeId: string,
        workspaceName: string,
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.machineName = machineName;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

export function decodeMobiusChannelDescriptor(value: unknown): MobiusChannelDescriptor {
    const channel = record(value, "channel descriptor");
    return new MobiusChannelDescriptor(
        arrayField(channel, "agents", 100).map(decodeAgentDescriptor),
        identifierField(channel, "channelId"),
        stringField(channel, "machineName", 255),
        identifierField(channel, "projectId"),
        identifierField(channel, "runtimeId"),
        stringField(channel, "workspaceName", 255),
    );
}

export function decodeRuntimeDescriptor(value: unknown): MobiusRuntimeDescriptor {
    const runtime = record(value, "Runtime descriptor");
    return new MobiusRuntimeDescriptor(
        arrayField(runtime, "agents", 100).map(decodeAgentDescriptor),
        identifierField(runtime, "channelId"),
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
    readonly machineName: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly status = MobiusRuntimePairingLifecycle.Paired;
    readonly workspaceName: string;

    constructor(
        agents: readonly MobiusAgentDescriptor[],
        channelId: string,
        machineName: string,
        projectId: string,
        runtimeId: string,
        workspaceName: string,
    ) {
        super();
        this.agents = agents;
        this.channelId = channelId;
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
            stringField(status, "machineName", 255),
            identifierField(status, "projectId"),
            identifierField(status, "runtimeId"),
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

export class MobiusPageRequest {
    readonly cursor: string;
    readonly limit: number;

    constructor(limit: number, cursor: string) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || cursor.length > 512) {
            throw new MobiusValidationError("The page request is invalid");
        }
        this.cursor = cursor;
        this.limit = limit;
    }
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
    readonly idempotencyKey: string;
    readonly request: TurnRequest;
    readonly sessionId: string;
    readonly state: MobiusTurnState;
    readonly turnId: string;

    constructor(
        acceptedAt: string,
        bindingId: string,
        content: string,
        idempotencyKey: string,
        sessionId: string,
        sessionConfigurations: readonly SessionConfigurationSelection[],
        state: MobiusTurnState,
        turnId: string,
        request: TurnRequest = { content, kind: "prompt", sessionConfigurations },
    ) {
        this.acceptedAt = acceptedAt;
        this.bindingId = bindingId;
        this.idempotencyKey = idempotencyKey;
        this.request = request;
        this.sessionId = sessionId;
        this.state = state;
        this.turnId = turnId;
    }

    get content(): string {
        return this.request.kind === "prompt" ? this.request.content : "";
    }

    get sessionConfigurations(): readonly SessionConfigurationSelection[] {
        return this.request.kind === "prompt" ? this.request.sessionConfigurations : [];
    }
}

export function decodeMobiusTurn(value: unknown): MobiusTurn | null {
    const turn = decodeTurn(value);
    if (turn === null) {
        return null;
    }
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
        turn.request.kind === "prompt" ? turn.request.content : "",
        turn.idempotencyKey,
        turn.sessionId,
        turn.request.kind === "prompt" ? turn.request.sessionConfigurations : [],
        state,
        turn.turnId,
        turn.request,
    );
}
