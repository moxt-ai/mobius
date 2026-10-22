import type { SessionPrepareOptions } from "../../session/api/session-api.ts";
import type { SessionEventPage, SessionEventStore } from "../../session/history/session-event-store.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";

/** What a caller wants to preview from a saved native session. */
export interface NativeSessionPreviewRequest {
    readonly nativeSessionId: string;
    readonly eventLimit: number;
    readonly cursor: string | null;
}

/** Per-preview services an Adapter may use. */
export interface AdapterContext {
    readonly options: SessionPrepareOptions;
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
