import type {
    PromptMetadata,
    PromptUsage,
    SessionCapabilities,
    SessionConfigOption,
    SessionEvent,
    SessionEventPayload,
    SessionLiveEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import type { AdapterSessionConnection, LiveSessionConnectionOptions } from "../adapter/session-events.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { PromptContent } from "../client/prompt-content.ts";
import type { AcpContentExternalizer } from "../content/content-externalizer.ts";
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
    /** The Mobius session the previewed events are recorded under. */
    readonly sessionId: string;
}

/** Shared runtime resources; each adapter owns the query resources it acquires. */
export interface AdapterDependencies {
    readonly processes: AgentProcessPool;
    readonly contentExternalizer: AcpContentExternalizer;
}

/** Constructs one harness adapter for a runtime. */
export type AdapterResolver = (agent: AcpAgentDefinition, dependencies: AdapterDependencies) => Adapter;

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

/** Business-facing session operations. Transport and initialization belong to the adapter. */
export interface Adapter {
    readonly connectSession: (options: LiveSessionConnectionOptions) => AdapterSessionConnection;
    readonly cancel: (target: AdapterSessionTarget, signal: AbortSignal) => Promise<void>;
    readonly closeSession: (target: AdapterSessionTarget, signal: AbortSignal) => Promise<void>;
    readonly prompt: (
        target: AdapterSessionTarget,
        content: PromptContent,
        signal: AbortSignal,
    ) => Promise<AdapterPromptResult>;
    readonly steer: (
        target: AdapterSessionTarget,
        content: PromptContent,
        signal: AbortSignal,
    ) => Promise<{ readonly outcome: "injected" } | { readonly outcome: "startedNewTurn" }>;
    readonly renameSession: (
        target: AdapterSessionTarget,
        title: string,
        signal: AbortSignal,
    ) => Promise<{ readonly nativeRenameApplied: boolean }>;
    readonly configureSession: (
        target: AdapterSessionTarget,
        selection: SessionConfigurationSelection,
        signal: AbortSignal,
    ) => Promise<readonly SessionConfigOption[]>;
    readonly getCapabilities: (cwd: string, signal: AbortSignal) => Promise<SessionCapabilities>;
    readonly listSessions: (cwd: string, cursor: string | null, signal: AbortSignal) => Promise<NativeSessionPage>;
    readonly findSession: (
        cwd: string,
        nativeSessionId: string,
        budget: NativeSessionLookupBudget,
        signal: AbortSignal,
    ) => Promise<NativeSessionInfo>;
    readonly readSessionHistory: (
        cwd: string,
        additionalDirectories: readonly string[],
        request: NativeSessionPreviewRequest,
        signal: AbortSignal,
    ) => Promise<SessionEventPage>;
    readonly close: () => Promise<void>;
}
