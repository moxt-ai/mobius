import type {
    AgentModelEffort,
    PromptMetadata,
    PromptUsage,
    SessionCapabilities,
    SessionConfigOption,
    SessionEvent,
    SessionEventPayload,
    SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import type { AdapterSessionSubscriber } from "../adapter/session-events.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { PromptContent } from "../client/prompt-content.ts";
import type { AcpContentExternalizer, ExternalizeSessionUpdate } from "../content/content-externalizer.ts";
import type { NativeSessionInfo, NativeSessionPage } from "../protocol/native-session.ts";
import type { SessionConfigurationSelection } from "../protocol/session-config-protocol.ts";
import type { ProjectedToolCall } from "../tool-call-projection.ts";

/** One page of a saved native session's events. */
export interface SessionEventPage {
    readonly throughPosition: string;
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
    readonly truncated: boolean;
}

/** What the session's event store offers an adapter materializing projected history. */
export interface SessionEventStore {
    readonly append: (sessionId: string, event: SessionEventPayload) => SessionLiveEvent;
    readonly close: () => void;
    /**
     * The projected tool call announced with this identifier in its current
     * merged form, or `undefined` when no such announcement is recorded.
     */
    readonly getToolCall: (sessionId: string, toolCallId: string) => ProjectedToolCall | undefined;
    /** Records projected events without publishing them live. */
    readonly materialize: (
        sessionId: string,
        sessionGenerationId: string,
        events: readonly SessionEventPayload[],
    ) => void;
    /** Reads one page of recorded events. */
    readonly page: (sessionId: string, eventLimit: number, cursor: string | null) => SessionEventPage;
    readonly remove: (sessionId: string) => void;
    readonly reset: (sessionId: string) => void;
}

/** What a caller wants to preview from a saved native session. */
export interface NativeSessionPreviewRequest {
    readonly nativeSessionId: string;
    readonly eventLimit: number;
    readonly cursor: string | null;
}

/** Shared runtime resources; each adapter owns the query resources it acquires. */
export interface AdapterDependencies {
    readonly processes: AgentProcessPool;
    readonly contentExternalizer: AcpContentExternalizer;
}

/** Constructs one harness adapter for a runtime. */
export type AdapterResolver = (agent: AcpAgentDefinition, dependencies: AdapterDependencies) => Adapter;

/** Validated query scope; contains no execution-session recovery or process controls. */
export interface NativeSessionQuery {
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
    readonly signal: AbortSignal;
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
}

/** Application lookup budget; null allows all entries within the page budget. */
export interface NativeSessionLookupBudget {
    readonly maximumPages: number;
    readonly maximumEntries: number | null;
}

export interface AdapterSessionTarget {
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
}

export interface AdapterPromptResult {
    readonly stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
    readonly usage?: PromptUsage | null;
    readonly _meta?: PromptMetadata | null;
}

/** Normalized lifecycle output; no harness response escapes into business state. */
export interface AdapterSessionOpened {
    readonly nativeSessionId: string;
    readonly capabilities: SessionCapabilities;
    readonly configOptions: readonly SessionConfigOption[];
    readonly agentName: string;
    readonly agentVersion: string;
    readonly agentSettingsModelEffort: AgentModelEffort | null;
}

export interface AdapterSessionScope {
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
}

export interface AdapterSessionCreateParams extends AdapterSessionSubscriber {
    readonly scope: AdapterSessionScope;
    readonly signal: AbortSignal;
}

export interface AdapterSessionOpenParams extends AdapterSessionCreateParams {
    readonly nativeSessionId: string;
}

export interface AdapterSessionForkParams extends AdapterSessionCreateParams {
    readonly sourceNativeSessionId: string;
}

export interface AdapterSessionOperation extends AdapterSessionTarget {
    readonly signal: AbortSignal;
}

/**
 * A native history entry that changes whenever another native client, such as the Agent's
 * own terminal, appends to the conversation. An Agent process continues from the copy it
 * loaded, so callers compare it with the value recorded after their own writes settle; those
 * writes may also change it. An Agent whose native runtime refuses a second writer is untracked.
 */
export type NativeHistoryRevision =
    | { readonly kind: "untracked" }
    | { readonly kind: "tracked"; readonly latestEntryId: string };

/** Business-facing session operations. Transport and initialization belong to the adapter. */
export interface Adapter {
    readonly refreshAgent: (agent: AcpAgentDefinition) => void;
    readonly createSession: (params: AdapterSessionCreateParams) => Promise<AdapterSessionOpened>;
    readonly forkSession: (params: AdapterSessionForkParams) => Promise<AdapterSessionOpened>;
    readonly openSession: (params: AdapterSessionOpenParams) => Promise<AdapterSessionOpened>;
    readonly openSessionWithReplay: (params: AdapterSessionOpenParams) => Promise<AdapterSessionOpened>;
    readonly cancel: (params: AdapterSessionOperation) => Promise<"retained" | "closed">;
    readonly closeSession: (params: AdapterSessionOperation) => Promise<void>;
    /** Release a retained execution without changing the native conversation. */
    readonly releaseSession: (params: AdapterSessionOperation) => Promise<void>;
    readonly readNativeHistoryRevision: (params: AdapterSessionOperation) => Promise<NativeHistoryRevision>;
    readonly prompt: (
        params: AdapterSessionOperation & { readonly content: PromptContent },
    ) => Promise<AdapterPromptResult>;
    readonly steer: (
        params: AdapterSessionOperation & { readonly content: PromptContent },
    ) => Promise<{ readonly outcome: "injected" } | { readonly outcome: "startedNewTurn" }>;
    readonly renameSession: (
        params: AdapterSessionOperation & { readonly title: string },
    ) => Promise<{ readonly nativeRenameApplied: boolean }>;
    readonly configureSession: (
        params: AdapterSessionOperation & { readonly selection: SessionConfigurationSelection },
    ) => Promise<readonly SessionConfigOption[]>;
    readonly getCapabilities: (query: NativeSessionQuery) => Promise<SessionCapabilities>;
    readonly listSessions: (params: {
        readonly query: NativeSessionQuery;
        readonly cursor: string | null;
    }) => Promise<NativeSessionPage>;
    readonly findSession: (params: {
        readonly query: NativeSessionQuery;
        readonly nativeSessionId: string;
        readonly budget: NativeSessionLookupBudget;
    }) => Promise<NativeSessionInfo>;
    readonly readSessionHistory: (params: {
        readonly query: NativeSessionQuery;
        readonly request: NativeSessionPreviewRequest;
    }) => Promise<SessionEventPage>;
    readonly close: () => Promise<void>;
}
