import type {
    AgentModelEffort,
    AgentPromptResponse,
    ContentBlock,
    PromptExecutionContext,
    PromptImage,
    PromptResource,
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
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";

export interface SessionPrepareOptions {
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
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export interface SessionConfigureOptions extends SessionPrepareOptions {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly requestId: string;
    readonly value: string;
    readonly valueType: SessionConfigOption["type"];
}

export interface PromptContentOptions {
    readonly images: readonly PromptImage[];
    readonly lifecycle?: {
        readonly context?: PromptExecutionContext;
        readonly attemptId: string;
        readonly content: readonly ContentBlock[];
        readonly disposition?: string;
        readonly epoch: string;
        readonly targetCommandId?: string;
    };
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
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
    readonly onSessionEvent = (_event: SessionLiveEvent): Promise<void> => Promise.resolve();
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (_event: SessionInfoUpdatedEvent): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
}

export class PreparedSession {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly commands: readonly SessionCommand[];
    readonly configOptions: readonly SessionConfigOption[];
    readonly prompted: boolean;
    readonly restored: boolean;

    constructor(
        agentName: string,
        agentVersion: string,
        capabilities: SessionCapabilities,
        commands: readonly SessionCommand[],
        configOptions: readonly SessionConfigOption[],
        prompted: boolean,
        restored: boolean,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.capabilities = capabilities;
        this.commands = commands;
        this.configOptions = configOptions;
        this.prompted = prompted;
        this.restored = restored;
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

/** Finds the launch definition for a catalog Agent, re-discovering it when its executable changed. */
export type ResolveAgent = (agentId: string, signal: AbortSignal) => Promise<AcpAgentDefinition>;

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
