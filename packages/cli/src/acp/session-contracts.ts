import type {
    AgentContentEvent,
    AgentPromptResponse,
    ContentBlockV2,
    NativeSessionHistory,
    PromptImage,
    PromptResource,
    SessionCapabilities,
    SessionCommand,
    SessionCommandsUpdatedEvent,
    SessionConfigOption,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionEventPayloadV2,
    SessionInfoUpdatedEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
    SessionUsageUpdatedEvent,
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

export interface AcpNativeHistoryReader {
    readonly read: (
        options: AcpPrepareOptions,
        nativeSessionId: string,
        nativeTurn: () => { readonly commandId: string; readonly nativeTurnId: string } | null,
    ) => Promise<NativeSessionHistory | null>;
}

export interface AcpNativeEventReplayV2 {
    readonly nextCursor: string | null;
    readonly startPosition: number;
    readonly truncated: boolean;
    readonly events: readonly SessionEventPayloadV2[];
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
        readonly attemptId: string;
        readonly content: readonly ContentBlockV2[];
        readonly epoch: string;
    };
    readonly prompt: string;
    readonly resources: readonly PromptResource[];
}

export interface AcpTurnOptions extends AcpPrepareOptions, AcpPromptContentOptions {
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
    readonly onSessionEventV2?: (sessionId: string, event: SessionEventPayloadV2, position: number) => Promise<void>;
    readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
    readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
    readonly onContent: (event: AgentContentEvent) => Promise<void>;
    readonly onElicitation: (event: SessionElicitationRequestedEvent) => Promise<void>;
    readonly onElicitationResolved: (event: SessionElicitationResolvedEvent) => Promise<void>;
    readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
    readonly onPermission: (event: SessionPermissionRequestedEvent) => Promise<void>;
    readonly onPermissionResolved: (event: SessionPermissionResolvedEvent) => Promise<void>;
    readonly onUsage: (event: SessionUsageUpdatedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
    readonly onSessionEventV2 = (_sessionId: string, _event: SessionEventPayloadV2, _position: number): Promise<void> =>
        Promise.resolve();
    readonly onCommands = (): Promise<void> => Promise.resolve();
    readonly onConfig = (): Promise<void> => Promise.resolve();
    readonly onContent = (): Promise<void> => Promise.resolve();
    readonly onElicitation = (): Promise<void> => Promise.resolve();
    readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
    readonly onInfo = (): Promise<void> => Promise.resolve();
    readonly onPermission = (): Promise<void> => Promise.resolve();
    readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
    readonly onUsage = (): Promise<void> => Promise.resolve();
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

export class AcpAgentSettingsSnapshot {
    readonly agentName: string;
    readonly agentVersion: string;
    readonly configOptions: readonly SessionConfigOption[];

    constructor(agentName: string, agentVersion: string, configOptions: readonly SessionConfigOption[]) {
        this.agentName = agentName;
        this.agentVersion = agentVersion;
        this.configOptions = configOptions;
    }
}
