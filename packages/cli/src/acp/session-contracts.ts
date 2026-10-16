import type {
    AgentContentEvent,
    AgentModelEffort,
    AgentPromptResponse,
    ContentBlockV2,
    NativeSessionHistory,
    PromptExecutionContextV2,
    PromptImage,
    PromptResource,
    SessionCapabilities,
    SessionCommand,
    SessionCommandsUpdatedEvent,
    SessionConfigOption,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionEventV2,
    SessionInfoUpdatedEvent,
    SessionLiveEventV2,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-protocol";
import type { AcpAgentDefinition } from "../config.ts";
import type { AcpActivity, AcpActivityNarration } from "./activity.ts";
import type { NativeSessionOrigin } from "./native-session.ts";

export interface AcpPrepareOptions {
    readonly additionalDirectories: readonly string[];
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly origin?: NativeSessionOrigin;
}

export type AcpSessionRecovery = { readonly kind: "history-required" } | { readonly kind: "interactive-only" };

export type AcpNativeHistoryAccess =
    | { readonly kind: "acp" }
    | {
          readonly kind: "direct";
          readonly read: (
              nativeSessionId: string,
              nativeTurn: () => { readonly commandId: string; readonly nativeTurnId: string } | null,
          ) => Promise<NativeSessionHistory>;
      };

export interface AcpNativeHistoryReader {
    readonly access: (options: AcpPrepareOptions) => AcpNativeHistoryAccess;
}

export const acpNativeHistoryReader: AcpNativeHistoryReader = {
    access: () => ({ kind: "acp" }),
};

export interface AcpNativeEventReplayV2 {
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly truncated: boolean;
    readonly events: readonly SessionEventV2[];
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
    readonly lifecycleV2?: {
        readonly context?: PromptExecutionContextV2;
        readonly attemptId: string;
        readonly content: readonly ContentBlockV2[];
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
    readonly onActivity: (activity: AcpActivity) => Promise<void>;
    /**
     * Receives streamed narration increments. Optional: without a sink the same text
     * still arrives once on the completed activity snapshot, just without live updates.
     */
    readonly onNarration?: (narration: AcpActivityNarration) => Promise<void>;
    readonly onText: (text: string, messageId: string) => Promise<void>;
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
    readonly onSessionEventV2?: (event: SessionLiveEventV2) => Promise<void>;
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onContent: (event: AgentContentEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
    readonly onSessionEventV2 = (_event: SessionLiveEventV2): Promise<void> => Promise.resolve();
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onContent = (_event: AgentContentEvent): Promise<void> => Promise.resolve();
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
