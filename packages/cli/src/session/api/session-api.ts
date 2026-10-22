import type {
    AgentModelEffort,
    AgentPromptResponse,
    ContentBlock,
    PromptExecutionContext,
    PromptImage,
    PromptResource,
    SessionCapabilities,
    SessionCommand,
    SessionCommandsUpdatedEvent,
    SessionConfigOption,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionEvent,
    SessionInfoUpdatedEvent,
    SessionLiveEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";

export interface AcpPrepareOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly origin?: NativeSessionOrigin;
}

export type AcpSessionRecovery = { readonly kind: "history-required" } | { readonly kind: "interactive-only" };

export interface AcpNativeEventReplay {
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly truncated: boolean;
    readonly events: readonly SessionEvent[];
}

export interface AcpAgentSettingsInspectionOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly model?: string;
    readonly signal: AbortSignal;
}

export interface AcpConfigureOptions extends AcpPrepareOptions {
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly requestId: string;
    readonly value: string;
    readonly valueType: SessionConfigOption["type"];
}

export interface AcpPromptContentOptions {
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

export interface AcpTurnOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly cancellationRequested?: () => boolean;
    readonly commandId: string;
    readonly disposition?: string;
    readonly targetCommandId?: string;
}

export interface AcpSteerOptions extends AcpPrepareOptions, AcpPromptContentOptions {
    readonly commandId: string;
    readonly targetCommandId: string;
}

export interface AcpPermissionResponseOptions {
    readonly interactionId: string;
    readonly optionId: string;
    readonly outcome: SessionPermissionResolvedEvent["outcome"];
    readonly sessionId: string;
}

export interface AcpElicitationResponseOptions {
    readonly action: SessionElicitationResolvedEvent["action"];
    readonly content: string;
    readonly interactionId: string;
    readonly sessionId: string;
}

export type AcpPromptResult = AgentPromptResponse;

export interface AcpSessionObserver {
    readonly onSessionEvent?: (event: SessionLiveEvent) => Promise<void>;
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
    readonly onSessionEvent = (_event: SessionLiveEvent): Promise<void> => Promise.resolve();
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (_event: SessionInfoUpdatedEvent): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
}

export class AcpPreparedSession {
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

export type AcpAgentSettingsModelEffort =
    | { readonly kind: "complete"; readonly value: AgentModelEffort }
    | { readonly kind: "unavailable" };

export class AcpAgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];
    readonly modelEffort: AcpAgentSettingsModelEffort;

    constructor(
        agentName: string,
        agentVersion: string,
        configOptions: readonly SessionConfigOption[],
        modelEffort: AcpAgentSettingsModelEffort,
    ) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
        this.modelEffort = modelEffort;
    }
}
