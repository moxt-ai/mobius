import type { SessionEvent, SessionEventPayload, SessionLiveEvent } from "@moxt-ai/mobius-sdk/protocol";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
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

/** Per-preview services an Adapter may use. */
export interface AdapterContext {
    /**
     * The preview's preparation inputs. The full session preparation options stay in the
     * session layer; adapters receive only the agent, cwd, directories and signal here.
     */
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
    readonly signal: AbortSignal;
    /** The session's event store, for adapters that materialize projected history. */
    readonly events: SessionEventStore;
    /**
     * Previews by resuming the native session over ACP `session/load` through a transient
     * agent process. Adapters whose harness replays history only on resume use this.
     */
    readonly previewThroughAcp: (request: NativeSessionPreviewRequest) => Promise<SessionEventPage>;
}

/**
 * How a harness serves reads of a saved native session. Previews are read-only: an
 * adapter must not resume the source session or require its writer lock unless it
 * goes through `previewThroughAcp`, which owns the session/load lifecycle.
 */
export interface Adapter {
    readonly previewSessionEvents: (
        request: NativeSessionPreviewRequest,
        context: AdapterContext,
    ) => Promise<SessionEventPage>;
}

/** Resolves the adapter that owns a preview for the given agent. */
export type AdapterResolver = (agent: AcpAgentDefinition) => Adapter;
