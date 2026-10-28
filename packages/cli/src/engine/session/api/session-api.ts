import type {
    AgentModelEffort,
    AgentPromptResponse,
    ContentBlock,
    PromptExecutionContext,
    SessionCapabilities,
    SessionCloseNoticeEvent,
    SessionCommand,
    SessionCommandsUpdatedEvent,
    SessionConfigOption,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionInfoUpdatedEvent,
    SessionLiveEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
    SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { BackgroundActivity } from "../../acp/agent/in-process-endpoint.ts";
import type { PromptImageInput, PromptResourceInput } from "../../acp/client/prompt-content.ts";
import type { Adapter } from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";

export interface SessionPrepareOptions {
    readonly adapter: Adapter;
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly origin?: NativeSessionOrigin;
    /** The prompt's native-history behavior when this preparation starts a Session. */
    readonly recovery?: SessionRecovery;
}

export type SessionRecovery =
    | { readonly kind: "history-required" }
    | { readonly kind: "interactive-only" }
    | { readonly kind: "execution-only" };

export interface AgentSettingsInspectionOptions {
    readonly adapter: Adapter;
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export interface SessionConfigureOptions extends SessionPrepareOptions {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly expectedConfigurationRevision?: string;
    readonly requestId: string;
    readonly value: string;
    readonly valueType: SessionConfigOption["type"];
}

export interface PromptContentOptions {
    readonly images: readonly PromptImageInput[];
    readonly lifecycle?: {
        readonly context?: PromptExecutionContext;
        readonly attemptId: string;
        readonly content: readonly ContentBlock[];
        readonly disposition?: string;
        readonly epoch: string;
        readonly targetCommandId?: string;
    };
    readonly prompt: string;
    readonly resources: readonly PromptResourceInput[];
}

export interface SessionTurnOptions extends SessionPrepareOptions, PromptContentOptions {
    readonly cancellationRequested?: () => boolean;
    readonly commandId: string;
    readonly disposition?: string;
    readonly targetCommandId?: string;
}

export interface SessionSteerOptions extends SessionPrepareOptions, PromptContentOptions {
    readonly commandId: string;
    readonly targetCommandId: string;
}

export interface PermissionResponseOptions {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: SessionPermissionResolvedEvent["outcome"];
    readonly sessionId: string;
}

export interface ElicitationResponseOptions {
    readonly action: SessionElicitationResolvedEvent["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}

export type PromptResult = AgentPromptResponse;

export interface SessionObserver {
    readonly onBackgroundActivity?: (source: object, activity: BackgroundActivity) => void;
    readonly onSessionEvent?: (event: SessionLiveEvent) => Promise<void>;
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
}

export class NullSessionObserver implements SessionObserver {
    readonly onBackgroundActivity = (_source: object, _activity: BackgroundActivity): void => {};
    readonly onSessionEvent = (_event: SessionLiveEvent): Promise<void> => Promise.resolve();
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (_event: SessionInfoUpdatedEvent): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
}

export interface SessionConfigurationSnapshot {
    readonly configOptions: readonly SessionConfigOption[];
    readonly configurationRevision: string;
}

export class PreparedSession {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly prompted: boolean;
    readonly restored: boolean;
    readonly configurationRevision: string;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        prompted: boolean,
        restored: boolean,
        configurationRevision: string,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.prompted = prompted;
        this.restored = restored;
        this.configurationRevision = configurationRevision;
    }
}

export type AgentSettingsModelEffort =
    | { readonly kind: "complete"; readonly value: AgentModelEffort }
    | { readonly kind: "unavailable" };

export class AgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];
    readonly modelEffort: AgentSettingsModelEffort;

    constructor(
        agentName: string,
        agentVersion: string,
        configOptions: readonly SessionConfigOption[],
        modelEffort: AgentSettingsModelEffort,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
        this.modelEffort = modelEffort;
    }
}

// What the runtime supplies to the session layer. The session layer never imports the runtime.

/** Resolves a catalog Agent's current launch definition and its Runtime-owned adapter. */
export type ResolveAgent = (
    agentId: string,
    signal: AbortSignal,
    sessionId?: string,
) => Promise<{
    readonly agent: AcpAgentDefinition;
    readonly adapter: Adapter;
}>;

/** Records a failure's code and correlation identifiers in the local diagnostics log, never its text. */
export type ReportFailure = (event: string, requestId: string, details: Readonly<Record<string, string>>) => void;

/** Delivers session events to connected clients. The runtime's relay publisher implements it. */
export interface SessionEventSink {
    readonly publish: (event: SessionLiveEvent) => void;
    readonly publishClosed: (event: SessionCloseNoticeEvent) => void;
    readonly publishInfo: (event: SessionInfoUpdatedEvent) => void;
    readonly publishOperationFailure: (sessionId: string, requestId: string, code: string, message: string) => void;
    readonly publishStatus: (event: SessionStatusChangedEvent) => void;
}
