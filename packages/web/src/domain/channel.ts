import type { AgentInstallationStage } from "@moxt-ai/mobius-sdk";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export class AgentOption {
    readonly id: string;
    readonly label: string;
    readonly agentPath: string;
    readonly agentVersion: string;
    constructor(id: string, label: string, agentPath: string, agentVersion: string) {
        this.id = id;
        this.label = label;
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
    }
}

export abstract class InstallableAgentOption {
    readonly id: string;
    readonly label: string;
    abstract readonly status: string;

    protected constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }
}

export class MissingAgentOption extends InstallableAgentOption {
    readonly status = "agent_not_installed";

    constructor(id: string, label: string) {
        super(id, label);
    }
}

export class AgentIntegrationOption extends InstallableAgentOption {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly status = "integration_not_installed";

    constructor(id: string, label: string, agentPath: string, agentVersion: string) {
        super(id, label);
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
    }
}

export abstract class AgentInstallationViewState {
    readonly agentId: string;
    abstract readonly canCancel: boolean;
    abstract readonly message: string;
    abstract readonly status: string;

    protected constructor(agentId: string) {
        this.agentId = agentId;
    }
}

export class IdleAgentInstallationState extends AgentInstallationViewState {
    readonly canCancel = false;
    readonly message = "Integration is not installed.";
    readonly status = "idle";

    constructor(agentId: string) {
        super(agentId);
    }
}

export abstract class RequestedAgentInstallationState extends AgentInstallationViewState {
    readonly requestId: string;

    protected constructor(agentId: string, requestId: string) {
        super(agentId);
        this.requestId = requestId;
    }
}

export class RequestingAgentInstallationState extends RequestedAgentInstallationState {
    readonly canCancel = true;
    readonly message = "Checking the local Agent.";
    readonly status = "requesting";

    constructor(agentId: string, requestId: string) {
        super(agentId, requestId);
    }
}

export class StartingAgentInstallationState extends RequestedAgentInstallationState {
    readonly canCancel = true;
    readonly message = "Starting integration installation.";
    readonly status = "starting";

    constructor(agentId: string, requestId: string) {
        super(agentId, requestId);
    }
}

function installationStageMessage(stage: AgentInstallationStage): string {
    if (stage === "downloading") {
        return "Downloading integration files.";
    }
    if (stage === "verifying") {
        return "Verifying integration files.";
    }
    if (stage === "installing_agent") {
        return "Preparing the integration.";
    }
    if (stage === "installing_adapter") {
        return "Installing or locating the ACP adapter.";
    }
    if (stage === "checking_acp") {
        return "Checking the complete ACP connection.";
    }
    throw new Error("Unsupported Agent integration installation stage");
}

export class RunningAgentInstallationState extends RequestedAgentInstallationState {
    readonly canCancel = true;
    readonly message: string;
    readonly stage: AgentInstallationStage;
    readonly status = "running";

    constructor(agentId: string, requestId: string, stage: AgentInstallationStage) {
        super(agentId, requestId);
        this.message = installationStageMessage(stage);
        this.stage = stage;
    }
}

export class SucceededAgentInstallationState extends RequestedAgentInstallationState {
    readonly authenticationMayBeRequired: boolean;
    readonly canCancel = false;
    readonly message: string;
    readonly status = "succeeded";

    constructor(agentId: string, requestId: string, authenticationMayBeRequired: boolean) {
        super(agentId, requestId);
        this.authenticationMayBeRequired = authenticationMayBeRequired;
        this.message = authenticationMayBeRequired
            ? "Integration ready; Agent sign-in may still be required."
            : "Integration ready.";
    }
}

export class FailedAgentInstallationState extends RequestedAgentInstallationState {
    readonly canCancel = false;
    readonly code: string;
    readonly message: string;
    readonly status = "failed";

    constructor(agentId: string, requestId: string, code: string, message: string) {
        super(agentId, requestId);
        this.code = code;
        this.message = message;
    }
}

export class CancelledAgentInstallationState extends RequestedAgentInstallationState {
    readonly canCancel = false;
    readonly message = "Integration installation was cancelled.";
    readonly status = "cancelled";

    constructor(agentId: string, requestId: string) {
        super(agentId, requestId);
    }
}

export abstract class ChannelCredentialAuthority {}

export class OwnerChannelCredentialAuthority extends ChannelCredentialAuthority {}

export class LinkedChannelCredentialAuthority extends ChannelCredentialAuthority {}

/**
 * Addresses one Runtime of a Project rather than a single channel. The selected Runtime's host socket is
 * reached through the Project Runtime route, so the relay routes it to that machine's Durable Object
 * instead of the browser's own channel. The channel that opened the route travels beside the authority in
 * `ChannelConnection.accessChannelId`, because credential storage and the device-access page belong to
 * that channel while the host socket belongs to the Runtime.
 */
export class ProjectRuntimeCredentialAuthority extends ChannelCredentialAuthority {
    readonly accessChannelId: string;

    constructor(accessChannelId: string) {
        super();
        this.accessChannelId = accessChannelId;
    }
}

export class StandaloneProjectRuntimeCredentialAuthority extends ProjectRuntimeCredentialAuthority {}

export class ChannelConnection {
    readonly accessChannelId: string;
    readonly agents: readonly AgentOption[];
    readonly channelId: string;
    readonly credentialAuthority: ChannelCredentialAuthority;
    readonly installableAgents: readonly InstallableAgentOption[];
    readonly machineName: string;
    readonly hostToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly AgentOption[],
        channelId: string,
        credentialAuthority: ChannelCredentialAuthority,
        machineName: string,
        workspaceName: string,
        hostToken: string,
        projectId: string,
        runtimeId: string,
        installableAgents: readonly InstallableAgentOption[] = [],
        accessChannelId: string = channelId,
    ) {
        this.accessChannelId = accessChannelId;
        this.agents = agents;
        this.channelId = channelId;
        this.credentialAuthority = credentialAuthority;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.hostToken = hostToken;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.workspaceName = workspaceName;
    }
}

export class CreatedPairing {
    readonly browserToken: string;
    readonly channelId: string;
    readonly expiresAt: Date;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly projectId: string;
    readonly runtimeId: string;

    constructor(
        pairingId: string,
        pairingCode: string,
        channelId: string,
        expiresAt: Date,
        browserToken: string,
        projectId: string,
        runtimeId: string,
    ) {
        this.browserToken = browserToken;
        this.pairingId = pairingId;
        this.pairingCode = pairingCode;
        this.channelId = channelId;
        this.expiresAt = expiresAt;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
    }
}

export class CreatedChannelAccessGrant {
    readonly expiresAt: Date;
    readonly grantId: string;
    readonly grantSecret: string;

    constructor(grantId: string, grantSecret: string, expiresAt: Date) {
        this.expiresAt = expiresAt;
        this.grantId = grantId;
        this.grantSecret = grantSecret;
    }
}

export class LinkedChannelDevice {
    readonly createdAt: Date;
    readonly credentialId: string;
    readonly lastUsedAt: Date;

    constructor(credentialId: string, createdAt: Date, lastUsedAt: Date) {
        this.createdAt = createdAt;
        this.credentialId = credentialId;
        this.lastUsedAt = lastUsedAt;
    }
}

export abstract class BrowserPairingStatus {
    abstract readonly status: string;
}

export class WaitingBrowserPairingStatus extends BrowserPairingStatus {
    readonly expiresAt: Date;
    readonly status = "pending";

    constructor(expiresAt: Date) {
        super();
        this.expiresAt = expiresAt;
    }
}

export class ExpiredBrowserPairingStatus extends BrowserPairingStatus {
    readonly status = "expired";
}

export class ConnectedBrowserPairingStatus extends BrowserPairingStatus {
    readonly connection: ChannelConnection;
    readonly status = "paired";

    constructor(connection: ChannelConnection) {
        super();
        this.connection = connection;
    }
}

export class PairingApiError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingApiError";
    }
}

export function isIdentifier(value: string): boolean {
    return IDENTIFIER_PATTERN.test(value);
}

export function isToken(value: string): boolean {
    return TOKEN_PATTERN.test(value);
}
