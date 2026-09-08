import type {
    AgentDisplayContent,
    AgentInstallationStage,
    NativeSessionHistory,
    PromptImage,
    PromptResource,
    SessionElicitationRequestedEvent,
    SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-web-sdk";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;

export class AgentOption {
    readonly agentPath: string;
    readonly agentVersion: string;
    readonly id: string;
    readonly label: string;

    constructor(id: string, label: string, agentPath: string, agentVersion: string) {
        this.agentPath = agentPath;
        this.agentVersion = agentVersion;
        this.id = id;
        this.label = label;
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

export class RecordedActivity {
    readonly activityId: string;
    readonly attemptId: string;
    readonly activityType: string;
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;
    readonly content: readonly AgentDisplayContent[];
    readonly detailAvailability: "available" | "inline" | "truncated" | "unrecorded";

    constructor(
        activityId: string,
        attemptId: string,
        activityType: string,
        input: string,
        locations: readonly string[],
        name: string,
        output: string,
        sequence: number,
        status: string,
        title: string,
        toolKind: string,
        content: readonly AgentDisplayContent[] = [],
        detailAvailability: RecordedActivity["detailAvailability"] = "inline",
    ) {
        this.activityId = activityId;
        this.attemptId = attemptId;
        this.activityType = activityType;
        this.input = input;
        this.locations = locations;
        this.name = name;
        this.output = output;
        this.sequence = sequence;
        this.status = status;
        this.title = title;
        this.toolKind = toolKind;
        this.content = content;
        this.detailAvailability = detailAvailability;
    }
}

export class RecordedContent {
    readonly commandId: string;
    readonly content: AgentDisplayContent;
    readonly contentId: string;
    readonly messageId: string;

    constructor(commandId: string, contentId: string, messageId: string, content: AgentDisplayContent) {
        this.commandId = commandId;
        this.content = content;
        this.contentId = contentId;
        this.messageId = messageId;
    }
}

export class RecordedSession {
    readonly additionalDirectoryIds: readonly string[];
    readonly agentId: string;
    readonly directoryId: string;
    readonly bindingId: string;
    readonly configRevision: number;
    readonly elicitations: readonly SessionElicitationRequestedEvent[];
    readonly runtimeId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly nativeHistory: NativeSessionHistory | null;
    readonly permissions: readonly SessionPermissionRequestedEvent[];
    readonly lastCommittedSeq: string;

    constructor(
        agentId: string,
        bindingId: string,
        configRevision: number,
        directoryId: string,
        runtimeId: string,
        sessionId: string,
        title: string,
        updatedAt: string,
        nativeHistory: NativeSessionHistory | null,
        elicitations: readonly SessionElicitationRequestedEvent[] = [],
        permissions: readonly SessionPermissionRequestedEvent[] = [],
        additionalDirectoryIds: readonly string[] = [],
        lastCommittedSeq = "0",
    ) {
        this.additionalDirectoryIds = [...additionalDirectoryIds];
        this.agentId = agentId;
        this.bindingId = bindingId;
        this.configRevision = configRevision;
        this.directoryId = directoryId;
        this.elicitations = elicitations;
        this.runtimeId = runtimeId;
        this.sessionId = sessionId;
        this.title = title;
        this.updatedAt = updatedAt;
        this.nativeHistory = nativeHistory;
        this.permissions = permissions;
        this.lastCommittedSeq = lastCommittedSeq;
    }
}

export class ChannelConnection {
    readonly agents: readonly AgentOption[];
    readonly channelId: string;
    readonly installableAgents: readonly InstallableAgentOption[];
    readonly machineName: string;
    readonly hostToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;
    readonly workspaceName: string;

    constructor(
        agents: readonly AgentOption[],
        channelId: string,
        machineName: string,
        workspaceName: string,
        hostToken: string,
        tenantId: string,
        projectId: string,
        runtimeId: string,
        installableAgents: readonly InstallableAgentOption[] = [],
    ) {
        this.agents = agents;
        this.channelId = channelId;
        this.installableAgents = installableAgents;
        this.machineName = machineName;
        this.hostToken = hostToken;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.tenantId = tenantId;
        this.workspaceName = workspaceName;
    }
}

export abstract class RecordedTurn {
    readonly activities: readonly RecordedActivity[];
    readonly agentId: string;
    readonly commandId: string;
    readonly createdAt: Date;
    readonly images: readonly PromptImage[];
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
    readonly response: string;
    readonly sessionId: string;
    readonly contents: readonly RecordedContent[];
    abstract readonly status: string;

    protected constructor(
        agentId: string,
        commandId: string,
        createdAt: Date,
        prompt: string,
        response: string,
        sessionId: string,
        activities: readonly RecordedActivity[],
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        contents: readonly RecordedContent[],
    ) {
        this.activities = activities;
        this.agentId = agentId;
        this.commandId = commandId;
        this.createdAt = createdAt;
        this.images = images;
        this.prompt = prompt;
        this.resources = resources;
        this.response = response;
        this.sessionId = sessionId;
        this.contents = contents;
    }
}

export class PendingRecordedTurn extends RecordedTurn {
    readonly status = "pending";

    constructor(
        agentId: string,
        commandId: string,
        createdAt: Date,
        prompt: string,
        response: string,
        sessionId: string,
        activities: readonly RecordedActivity[] = [],
        images: readonly PromptImage[] = [],
        resources: readonly PromptResource[] = [],
        contents: readonly RecordedContent[] = [],
    ) {
        super(agentId, commandId, createdAt, prompt, response, sessionId, activities, images, resources, contents);
    }
}

export class RunningRecordedTurn extends RecordedTurn {
    readonly attemptId: string;
    readonly status = "running";

    constructor(
        agentId: string,
        commandId: string,
        createdAt: Date,
        prompt: string,
        response: string,
        sessionId: string,
        attemptId: string,
        activities: readonly RecordedActivity[] = [],
        images: readonly PromptImage[] = [],
        resources: readonly PromptResource[] = [],
        contents: readonly RecordedContent[] = [],
    ) {
        super(agentId, commandId, createdAt, prompt, response, sessionId, activities, images, resources, contents);
        this.attemptId = attemptId;
    }
}

export class CompletedRecordedTurn extends RecordedTurn {
    readonly attemptId: string;
    readonly status = "completed";
    readonly stopReason: string;

    constructor(
        agentId: string,
        commandId: string,
        createdAt: Date,
        prompt: string,
        response: string,
        sessionId: string,
        attemptId: string,
        stopReason: string,
        activities: readonly RecordedActivity[] = [],
        images: readonly PromptImage[] = [],
        resources: readonly PromptResource[] = [],
        contents: readonly RecordedContent[] = [],
    ) {
        super(agentId, commandId, createdAt, prompt, response, sessionId, activities, images, resources, contents);
        this.attemptId = attemptId;
        this.stopReason = stopReason;
    }
}

export class FailedRecordedTurn extends RecordedTurn {
    readonly code: string;
    readonly message: string;
    readonly status = "failed";

    constructor(
        agentId: string,
        commandId: string,
        createdAt: Date,
        prompt: string,
        response: string,
        sessionId: string,
        code: string,
        message: string,
        activities: readonly RecordedActivity[] = [],
        images: readonly PromptImage[] = [],
        resources: readonly PromptResource[] = [],
        contents: readonly RecordedContent[] = [],
    ) {
        super(agentId, commandId, createdAt, prompt, response, sessionId, activities, images, resources, contents);
        this.code = code;
        this.message = message;
    }
}

export class ChannelHistory {
    readonly sessions: readonly RecordedSession[];
    readonly turns: readonly RecordedTurn[];

    constructor(turns: readonly RecordedTurn[], sessions: readonly RecordedSession[] = []) {
        this.sessions = sessions;
        this.turns = turns;
    }
}

export class CreatedPairing {
    readonly channelId: string;
    readonly expiresAt: Date;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly pollToken: string;
    readonly hostToken: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;

    constructor(
        pairingId: string,
        pairingCode: string,
        pollToken: string,
        channelId: string,
        expiresAt: Date,
        hostToken: string,
        tenantId: string,
        projectId: string,
        runtimeId: string,
    ) {
        this.pairingId = pairingId;
        this.pairingCode = pairingCode;
        this.pollToken = pollToken;
        this.channelId = channelId;
        this.expiresAt = expiresAt;
        this.hostToken = hostToken;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.tenantId = tenantId;
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

export function isPairingCode(value: string): boolean {
    return PAIRING_CODE_PATTERN.test(value);
}
